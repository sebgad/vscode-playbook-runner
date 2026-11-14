# Task-range strategy for the Playbook Runner VS Code extension.
#
# ansible-playbook has --start-at-task but nothing to stop at, and
# --start-at-task skips every task before the match -- including the setup
# tasks whose facts the rest of a play needs. This strategy is `linear` with a
# filter in front of it: the extension enables it for one run through
# ANSIBLE_STRATEGY / ANSIBLE_STRATEGY_PLUGINS and describes the range in env.
#
# It overrides a private method of the linear strategy, which is the price of
# doing this at all. test/range-plugin.test.js runs it against the installed
# ansible-core; that suite failing after an ansible upgrade is the signal.

from __future__ import annotations

DOCUMENTATION = """
    name: playbook_runner_range
    short_description: Runs a range of tasks, otherwise like linear
    description:
        - Like the linear strategy, but runs only the tasks from
          PLAYBOOK_RUNNER_FROM_TASK until PLAYBOOK_RUNNER_UNTIL_TASK (either may
          be empty for an open end), plus, before the start, fact gathering,
          include tasks and tasks tagged with one of PLAYBOOK_RUNNER_SETUP_TAGS.
        - Task names match exactly, as written before templating, the bare
          name or the role-prefixed one. Handlers notified in the range still
          run.
        - Set by the Playbook Runner VS Code extension; not meant to be
          configured by hand.
    author: Playbook Runner
"""

import json
import os

from ansible import constants as C
from ansible.playbook.handler import Handler
from ansible.plugins.strategy.linear import StrategyModule as LinearStrategyModule
from ansible.utils.display import Display

display = Display()

# meta tasks ansible inserts on its own; they keep handlers and roles working
# and do nothing a range should hold back. A meta written in a playbook is
# treated like any other task.
_IMPLICIT_META = frozenset(("flush_handlers", "role_complete", "noop", "end_role"))


class _Range:
    """The range for the whole run. One strategy object is made per play, so
    this lives at module level, which the plugin loader keeps for the process."""

    def __init__(self):
        self.from_task = os.environ.get("PLAYBOOK_RUNNER_FROM_TASK", "")
        self.until_task = os.environ.get("PLAYBOOK_RUNNER_UNTIL_TASK", "")
        self.status_file = os.environ.get("PLAYBOOK_RUNNER_STATUS_FILE", "")
        try:
            tags = json.loads(os.environ.get("PLAYBOOK_RUNNER_SETUP_TAGS", "[]"))
        except ValueError:
            tags = []
        self.setup_tags = frozenset(t for t in tags if isinstance(t, str)) if isinstance(tags, list) else frozenset()
        self.from_matched = not self.from_task
        self.until_matched = False
        self.done = False

    def announce(self):
        start = "«%s»" % self.from_task if self.from_task else "the start"
        end = "«%s»" % self.until_task if self.until_task else "the end"
        display.banner("Playbook Runner: running from %s until %s" % (start, end))
        self.write()

    def write(self):
        if not self.status_file:
            return
        try:
            with open(self.status_file, "w", encoding="utf-8") as handle:
                json.dump({"fromMatched": self.from_matched, "untilMatched": self.until_matched}, handle)
        except OSError as err:
            display.warning("Playbook Runner: could not write %s: %s" % (self.status_file, err))

    @staticmethod
    def names(task):
        return {task.get_name(), task.name}

    def keep(self, task):
        if isinstance(task, Handler):
            return True
        if task.action in C._ACTION_META and task.args.get("_raw_params") in _IMPLICIT_META:
            return True
        if self.done:
            return False

        if not self.from_matched:
            if self.from_task not in self.names(task):
                return (
                    task.action in C._ACTION_FACT_GATHERING
                    or task.action in C._ACTION_ALL_INCLUDES
                    or bool(self.setup_tags.intersection(task.tags))
                )
            self.from_matched = True
            self.write()

        # Inside the range. Checked only here, so `until` is its first
        # occurrence at or after `from`.
        if self.until_task and self.until_task in self.names(task):
            self.until_matched = True
            self.done = True
            self.write()
        return True


_RANGE = None


class StrategyModule(LinearStrategyModule):
    def __init__(self, tqm):
        super().__init__(tqm)
        global _RANGE
        if _RANGE is None:
            _RANGE = _Range()
            _RANGE.announce()
        self._range = _RANGE

    def _get_next_task_lockstep(self, hosts, iterator):
        # The parent advances every host past the task it returns, so a batch
        # that is not kept is simply never executed.
        while True:
            batch = super()._get_next_task_lockstep(hosts, iterator)
            if not batch or self._range.keep(batch[0][1]):
                return batch
