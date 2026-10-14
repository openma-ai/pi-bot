"""Command line interface for the WorkQueue store.

Usage::

    python -m workqueue.cli --db PATH {add,start,complete,cancel,list,export} ...

Successful commands print a single JSON document to stdout.  Validation
failures exit non-zero with a short message on stderr and never let a
traceback escape.
"""

import argparse
import csv
import json
import sys

from workqueue.store import Queue


def _build_parser():
    parser = argparse.ArgumentParser(
        prog='workqueue.cli',
        description='Manage a WorkQueue SQLite database.',
    )
    parser.add_argument(
        '--db',
        required=True,
        metavar='PATH',
        help='path to the SQLite queue database',
    )
    sub = parser.add_subparsers(dest='command', metavar='SUBCMD')
    sub.required = True

    add = sub.add_parser('add', help='create a new pending task')
    add.add_argument('id', help='unique task id')
    add.add_argument('--title', required=True, help='human readable title')
    add.add_argument('--owner', required=True, help='owning user/team')
    add.add_argument(
        '--depends',
        action='append',
        nargs='+',
        metavar='ID',
        default=None,
        help='id of a dependency task (repeatable)',
    )

    for name, help_text in (
        ('start', 'move a pending task to running'),
        ('complete', 'move a running task to done'),
        ('cancel', 'cancel a pending or running task'),
    ):
        cmd = sub.add_parser(name, help=help_text)
        cmd.add_argument('id', help='task id')

    lst = sub.add_parser('list', help='list tasks as JSON')
    lst.add_argument('--owner', default=None, help='filter by owner')
    lst.add_argument('--status', default=None, help='filter by status')

    export = sub.add_parser('export', help='export aggregate statistics')
    export.add_argument(
        '--format',
        required=True,
        choices=['csv'],
        dest='export_format',
        help='output format (csv)',
    )
    return parser


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')


def _flatten_depends(values):
    if not values:
        return None
    flat = []
    for group in values:
        flat.extend(group)
    return flat


def _dispatch(args):
    if args.command == 'add':
        deps = _flatten_depends(args.depends)
        q = Queue(args.db)
        try:
            q.add(args.id, args.title, args.owner, deps)
            _emit(q.get(args.id))
        finally:
            q.close()
        return 0

    if args.command in ('start', 'complete', 'cancel'):
        q = Queue(args.db)
        try:
            if args.command == 'start':
                q.start(args.id)
                _emit(q.get(args.id))
            elif args.command == 'complete':
                changed = q.complete(args.id)
                task = q.get(args.id)
                task['changed'] = changed
                _emit(task)
            else:
                changed = q.cancel(args.id)
                task = q.get(args.id)
                task['changed'] = changed
                _emit(task)
        finally:
            q.close()
        return 0

    if args.command == 'list':
        q = Queue(args.db)
        try:
            _emit(q.list(owner=args.owner, status=args.status))
        finally:
            q.close()
        return 0

    if args.command == 'export':
        q = Queue(args.db)
        try:
            tasks = q.list()
        finally:
            q.close()
        totals = {}
        for task in tasks:
            owner = task['owner']
            entry = totals.setdefault(owner, [0, 0])
            entry[0] += 1
            if task['status'] == 'done':
                entry[1] += 1
        writer = csv.writer(sys.stdout, lineterminator='\n')
        writer.writerow(['owner', 'total', 'done', 'completion_rate'])
        for owner in sorted(totals):
            total, done = totals[owner]
            rate = (done / total) if total else 0.0
            writer.writerow([owner, total, done, '%.6f' % rate])
        return 0

    raise ValueError('unknown command: %s' % args.command)


def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        return _dispatch(args)
    except (ValueError, KeyError) as exc:
        message = exc.args[0] if exc.args else str(exc)
        print('error: %s' % message, file=sys.stderr)
        return 1
    except Exception as exc:  # pragma: no cover - defensive top-level guard
        print('error: %s' % exc, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
