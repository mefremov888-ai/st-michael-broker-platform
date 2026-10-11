import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-plaud-server-monitor.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PreflightValidationTests(unittest.TestCase):
    def config(self):
        return {'mode': 'CHECK_CONFIG', 'status': 'SUCCEEDED', 'bot_verified': True,
                'recipient_count': 1, 'lookback_days': 7}

    def counts(self):
        return {'mode': 'CHECK_ONLY', 'status': 'SUCCEEDED', 'job_day': '2026-10-11',
                'lookback_days': 7, 'counts': {'recordings': 18, 'misnamed': 16},
                'notification_sent': False}

    def test_accepts_only_explicit_config_and_check_success(self):
        installer.validate_preflight(self.config(), '--check-config')
        installer.validate_preflight(self.counts(), '--check-only')

    def test_empty_successful_process_is_not_a_successful_preflight(self):
        with patch.object(installer.Path, 'read_text', return_value='[Service]\nType=oneshot\n'), patch.object(installer, 'run', return_value=''):
            with self.assertRaisesRegex(RuntimeError, 'preflight_output_missing'):
                installer.preflight()

    def test_failed_wrong_mode_or_sent_report_is_rejected(self):
        for key, value in [('status', 'FAILED'), ('mode', 'CHECK_CONFIG'), ('notification_sent', True)]:
            payload = self.counts()
            payload[key] = value
            with self.assertRaises(RuntimeError):
                installer.validate_preflight(payload, '--check-only')

    def test_bot_and_recipient_pin_are_required(self):
        for key, value in [('bot_verified', False), ('recipient_count', 2), ('lookback_days', 30)]:
            payload = self.config()
            payload[key] = value
            with self.assertRaises(RuntimeError):
                installer.validate_preflight(payload, '--check-config')

    def test_counts_are_numeric_consistent_and_no_private_fields_allowed(self):
        for counts in [{'recordings': 1, 'misnamed': 2}, {'recordings': True, 'misnamed': 0}, {'recordings': 2, 'misnamed': 1, 'name': 'private'}]:
            payload = self.counts()
            payload['counts'] = counts
            with self.assertRaises(RuntimeError):
                installer.validate_preflight(payload, '--check-only')
        payload = self.config()
        payload['token'] = 'private'
        with self.assertRaises(RuntimeError):
            installer.validate_preflight(payload, '--check-config')


if __name__ == '__main__':
    unittest.main()
