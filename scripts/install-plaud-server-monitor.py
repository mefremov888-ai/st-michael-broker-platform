#!/usr/bin/env python3
"""Install only the PLAUD name monitor. Never enable timers or send a report."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

APP = Path('/opt/plaud-name-monitor')
STATE = Path('/var/lib/plaud-name-monitor')
ENV = Path('/etc/plaud-name-monitor.env')
UNITS = ('plaud-name-monitor.service', 'plaud-name-monitor.timer',
         'plaud-name-monitor-watchdog.service', 'plaud-name-monitor-watchdog.timer')
CODE = ('monitor-plaud-file-names.mjs', 'monitor-plaud-server-runner.mjs')
OWNER_CHAT = '454322520'


def fail(category):
    raise RuntimeError(category)


def private_file(file):
    info = file.lstat()
    if not file.is_file() or file.is_symlink() or info.st_uid != 0 or info.st_mode & 0o077:
        fail('private_file_permissions_invalid')


def trusted_path(file, directory=False):
    info = file.lstat()
    if file.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
        fail('installation_path_permissions_invalid')
    if (directory and not file.is_dir()) or (not directory and (not file.is_file() or info.st_nlink != 1)):
        fail('installation_path_type_invalid')


def ensure_stopped():
    for name in UNITS:
        result = subprocess.run(['/usr/bin/systemctl', 'is-active', name],
                                capture_output=True, text=True, timeout=10)
        if result.stdout.strip() in ('active', 'activating', 'reloading', 'deactivating'):
            fail('stop_monitor_units_before_installation')


def read_env(file):
    private_file(file)
    values = {}
    for line in file.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            if key in values:
                fail('duplicate_environment_key')
            values[key] = value.strip().strip('\"\'')
    return values


def verify_bot(token):
    if not re.fullmatch(r'\d{6,}:[A-Za-z0-9_-]{25,}', token):
        fail('telegram_configuration_invalid')
    try:
        with urllib.request.urlopen(f'https://api.telegram.org/bot{token}/getMe', timeout=20) as response:
            payload = json.loads(response.read(65537))
        bot = payload.get('result', {})
        if payload.get('ok') is not True or bot.get('username', '').lower() != 'brokerstmichaelbot':
            fail('unexpected_telegram_bot')
        return int(bot['id'])
    except Exception:
        fail('telegram_identity_not_verified')


def atomic_write(file, content, mode):
    temporary = file.with_name(file.name + f'.install-{os.getpid()}')
    with temporary.open('xb') as stream:
        os.chmod(temporary, mode)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=240)
    if result.returncode:
        # External errors can include credentials. Do not echo them.
        fail('command_failed_' + Path(args[0]).name)
    return result.stdout.strip()


def validate_preflight(payload, mode):
    if not isinstance(payload, dict) or payload.get('status') != 'SUCCEEDED':
        fail('preflight_not_confirmed')
    if mode == '--check-config':
        allowed = {'mode', 'status', 'bot_verified', 'recipient_count', 'lookback_days'}
        if payload.get('mode') != 'CHECK_CONFIG' or payload.get('bot_verified') is not True or payload.get('recipient_count') != 1:
            fail('preflight_configuration_not_confirmed')
    else:
        allowed = {'mode', 'status', 'job_day', 'lookback_days', 'counts', 'notification_sent'}
        counts = payload.get('counts')
        if payload.get('mode') != 'CHECK_ONLY' or payload.get('notification_sent') is not False:
            fail('preflight_check_not_confirmed')
        if not isinstance(counts, dict) or set(counts) != {'recordings', 'misnamed'} or any(type(value) is not int for value in counts.values()):
            fail('preflight_counts_invalid')
        if not 0 <= counts['misnamed'] <= counts['recordings'] or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(payload.get('job_day', ''))):
            fail('preflight_counts_invalid')
    if set(payload) != allowed or payload.get('lookback_days') != 7:
        fail('preflight_payload_invalid')


def preflight():
    # Reuse the production sandbox, but override the action with read-only modes.
    properties = []
    section = None
    for line in Path('/etc/systemd/system/plaud-name-monitor.service').read_text().splitlines():
        if line.startswith('['):
            section = line
        elif section == '[Service]' and '=' in line:
            key, value = line.split('=', 1)
            if key not in ('ExecStart', 'Restart', 'RestartSec', 'TimeoutStartSec'):
                properties.append(f'--property={key}={value}')
    for mode in ('--check-config', '--check-only'):
        output = run(['/usr/bin/systemd-run', '--quiet', '--wait', '--pipe', '--collect',
                      '--unit=plaud-name-monitor-preflight', *properties,
                      '/usr/bin/node', str(APP / 'current' / CODE[1]), mode])
        # Only our runner's sanitized JSON is permitted into installer output.
        lines = [line for line in output.splitlines() if line.startswith('{')]
        if len(lines) != 1:
            fail('preflight_output_missing_or_ambiguous')
        payload = json.loads(lines[0])
        validate_preflight(payload, mode)
        print(json.dumps(payload, ensure_ascii=True))


def install(source, release, with_preflight=False):
    if os.geteuid() != 0 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', release):
        fail('installer_identity_or_release_invalid')
    source = source.resolve(strict=True)
    ensure_stopped()
    for parent in (Path('/opt'), Path('/etc'), Path('/etc/systemd'), Path('/etc/systemd/system'),
                   Path('/var'), Path('/var/lib'), Path('/root'), Path('/root/.plaud')):
        trusted_path(parent, directory=True)
    private_file(Path('/root/.plaud/tokens.json'))
    if not Path('/usr/bin/plaud').exists() or not Path('/usr/bin/node').exists():
        fail('plaud_or_node_missing')
    if APP.exists() and (APP.is_symlink() or APP.stat().st_uid != 0):
        fail('installation_path_invalid')
    APP.mkdir(mode=0o755, exist_ok=True)
    trusted_path(APP, directory=True)
    releases = APP / 'releases'
    releases.mkdir(mode=0o755, exist_ok=True)
    trusted_path(releases, directory=True)
    destination = releases / release
    destination.mkdir(mode=0o755, exist_ok=True)
    trusted_path(destination, directory=True)
    for name in CODE:
        trusted_path(source / 'scripts' / name)
        content = (source / 'scripts' / name).read_bytes()
        target = destination / name
        if target.exists() or target.is_symlink():
            trusted_path(target)
        if target.exists() and target.read_bytes() != content:
            fail('immutable_release_conflict')
        if not target.exists():
            atomic_write(target, content, 0o644)
        print('code_sha256 ' + name + ' ' + hashlib.sha256(content).hexdigest())
    if ENV.exists():
        values = read_env(ENV)
        if values.get('OPS_ALERT_CHAT_ID') != OWNER_CHAT or values.get('OPS_ALERT_CHAT_IDS'):
            fail('existing_recipients_require_explicit_review')
        bot_id = verify_bot(values.get('OPS_TELEGRAM_BOT_TOKEN', ''))
        if values.get('PLAUD_NAME_EXPECTED_BOT_ID') != str(bot_id):
            fail('existing_bot_pin_invalid')
    else:
        donor = read_env(Path('/opt/plaud-kontrol/.env'))
        token = donor.get('TG_BOT_TOKEN', '')
        bot_id = verify_bot(token)
        content = (f'OPS_TELEGRAM_BOT_TOKEN={token}\nOPS_ALERT_CHAT_ID={OWNER_CHAT}\n'
                   f'PLAUD_NAME_EXPECTED_BOT_ID={bot_id}\nPLAUD_NAME_LOOKBACK_DAYS=7\n'
                   f'PLAUD_NAME_STATE_FILE={STATE}/state.json\n').encode()
        atomic_write(ENV, content, 0o600)
    STATE.mkdir(mode=0o700, exist_ok=True)
    trusted_path(STATE, directory=True)
    os.chmod(STATE, 0o700)
    current = APP / 'current'
    if current.exists() or current.is_symlink():
        if not current.is_symlink() or not current.resolve().is_relative_to(releases.resolve()):
            fail('current_release_path_invalid')
    # Record the previous immutable release; rollback never touches OAuth/state.
    previous = current.resolve() if current.is_symlink() else None
    if previous:
        trusted_path(previous, directory=True)
        for name in CODE:
            trusted_path(previous / name)
    backups = {}
    for name in UNITS:
        trusted_path(source / 'ops' / 'plaud-name-monitor' / name)
        unit = Path('/etc/systemd/system') / name
        if unit.exists() or unit.is_symlink():
            trusted_path(unit)
            backups[name] = unit.read_bytes()
        else:
            backups[name] = None
    previous_file = APP / 'previous-release'
    if previous_file.exists() or previous_file.is_symlink():
        trusted_path(previous_file)
    old_previous = previous_file.read_bytes() if previous_file.exists() else None
    temporary = APP / f'current-install-{os.getpid()}'
    try:
        temporary.symlink_to(destination, target_is_directory=True)
        os.replace(temporary, current)
        if previous:
            atomic_write(APP / 'previous-release', (str(previous) + '\n').encode(), 0o644)
        for name in UNITS:
            atomic_write(Path('/etc/systemd/system') / name,
                         (source / 'ops' / 'plaud-name-monitor' / name).read_bytes(), 0o644)
        run(['/usr/bin/systemd-analyze', 'verify', *[str(Path('/etc/systemd/system') / name) for name in UNITS]])
        run(['/usr/bin/systemctl', 'daemon-reload'])
        if with_preflight:
            preflight()
    except Exception:
        if previous:
            rollback = APP / f'current-rollback-{os.getpid()}'
            rollback.symlink_to(previous, target_is_directory=True)
            os.replace(rollback, current)
        else:
            current.unlink(missing_ok=True)
        for name, content in backups.items():
            target = Path('/etc/systemd/system') / name
            if content is None:
                target.unlink(missing_ok=True)
            else:
                atomic_write(target, content, 0o644)
        if old_previous is None:
            (APP / 'previous-release').unlink(missing_ok=True)
        else:
            atomic_write(APP / 'previous-release', old_previous, 0o644)
        run(['/usr/bin/systemctl', 'daemon-reload'])
        raise
    print('installed release=' + release + ' recipient_count=1 timers_not_enabled_by_installer=true')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--release', required=True)
    parser.add_argument('--preflight', action='store_true')
    args = parser.parse_args()
    try:
        install(args.source, args.release, with_preflight=args.preflight)
    except Exception as cause:
        category = str(cause) if isinstance(cause, RuntimeError) else 'installation_failed'
        print('PLAUD monitor installation error: ' + category, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
