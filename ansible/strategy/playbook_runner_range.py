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
from ansible.errors import AnsibleError
from ansible.playbook.handler import Handler
from ansible.release import __version__ as ANSIBLE_VERSION
from ansible.plugins.strategy.linear import StrategyModule as LinearStrategyModule
from ansible.utils.display import Display

display = Display()

# The ansible-core major version the plugin accepts (workflow.md step 24).
# test/range-plugin.test.js has passed against 2.21 and 2.22; other 2.x
# releases are trusted untested. A different major is refused: a renamed
# private method would leave the override dead and `linear` would run the
# whole playbook. The method check below still guards any 2.x.
SUPPORTED_MAJOR = "2"


def check_compatible(version):
    """Raise unless this ansible-core is a supported major version and still
    has the method it overrides."""
    if version.split(".", 1)[0] != SUPPORTED_MAJOR:
        raise AnsibleError(
            "Playbook Runner: the task-range plugin supports ansible-core %s.x, not %s. "
            "Run the playbook without a task range, or update the plugin and its tests."
            % (SUPPORTED_MAJOR, version)
        )
    if "_get_next_task_lockstep" not in vars(LinearStrategyModule):
        raise AnsibleError("Playbook Runner: this ansible-core's linear strategy has no _get_next_task_lockstep.")

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
        self.consume_token()
        try:
            tags = json.loads(os.environ.get("PLAYBOOK_RUNNER_SETUP_TAGS", "[]"))
        except ValueError:
            tags = []
        self.setup_tags = frozenset(t for t in tags if isinstance(t, str)) if isinstance(tags, list) else frozenset()
        self.from_matched = not self.from_task
        self.until_matched = False
        self.done = False

    def consume_token(self):
        """The extension writes {"armed": true} to the status file just before
        it starts a range run, and nothing else ever does. This run replaces
        it with its result, so the same task replayed -- VS Code's Rerun Last
        Task, which skips the extension's checks -- finds no token and stops
        before any task runs."""
        try:
            with open(self.status_file, encoding="utf-8") as handle:
                armed = json.load(handle).get("armed") is True
        except (OSError, ValueError, AttributeError):
            armed = False
        if not armed:
            raise AnsibleError(
                "Playbook Runner: this task-range run was not started by Playbook Runner, or has run already. "
                "Start it again from the dashboard or the sidebar, so the range is checked first."
            )

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
    def name_of(task):
        # get_name() only, the way the outline names tasks: a play-level
        # "Create user" must never match "somerole : Create user".
        return task.get_name()

    def keep(self, task):
        if isinstance(task, Handler):
            return True
        if task.action in C._ACTION_META and task.args.get("_raw_params") in _IMPLICIT_META:
            return True
        if self.done:
            return False

        if not self.from_matched:
            if self.from_task != self.name_of(task):
                return (
                    task.action in C._ACTION_FACT_GATHERING
                    or task.action in C._ACTION_ALL_INCLUDES
                    or bool(self.setup_tags.intersection(task.tags))
                )
            self.from_matched = True
            self.write()

        # Inside the range. Checked only here, so `until` is its first
        # occurrence at or after `from`.
        if self.until_task and self.until_task == self.name_of(task):
            self.until_matched = True
            self.done = True
            self.write()
        return True


_RANGE = None


class StrategyModule(LinearStrategyModule):
    def __init__(self, tqm):
        super().__init__(tqm)
        check_compatible(ANSIBLE_VERSION)
        global _RANGE
        if _RANGE is None:
            _RANGE = _Range()
            _RANGE.announce()
        self._range = _RANGE

    def run(self, iterator, play_context):
        # A serial play is run batch after batch, each with a fresh strategy
        # but the same range state, so the range would only hold for the
        # first batch. The extension refuses such playbooks up front; this is
        # the fail-safe, before the first task.
        if iterator._play.serial:
            raise AnsibleError(
                "Playbook Runner: play %r sets serial:, which the task-range plugin does not support."
                % iterator._play.get_name()
            )
        return super().run(iterator, play_context)

    def _get_next_task_lockstep(self, hosts, iterator):
        # The parent advances every host past the task it returns, so a batch
        # that is not kept is simply never executed.
        while True:
            batch = super()._get_next_task_lockstep(hosts, iterator)
            if not batch or self._range.keep(batch[0][1]):
                return batch
