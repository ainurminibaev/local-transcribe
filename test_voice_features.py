import unittest

from voice_features import clean_windows


class VoiceWindowTests(unittest.TestCase):
    def test_five_second_windows_have_room_between_them_and_avoid_other_speakers(self):
        example = [
            {"speaker": 0, "start": 0, "end": 23},
            {"speaker": 1, "start": 9, "end": 12},
        ]
        starts = sorted(clean_windows(example, 0))
        self.assertGreaterEqual(len(starts), 2)
        for start in starts:
            self.assertGreaterEqual(start, 0.25)
            self.assertLessEqual(start + 5, 22.75)
            self.assertTrue(start + 5 <= 8.75 or start >= 12.25)
        self.assertTrue(all(b - a >= 5 for a, b in zip(starts, starts[1:])))

    def test_short_or_overlapping_speaker_stays_anonymous(self):
        example = [
            {"speaker": 0, "start": 0, "end": 5.3},
            {"speaker": 0, "start": 10, "end": 19},
            {"speaker": 1, "start": 14, "end": 19},
        ]
        self.assertEqual(clean_windows(example, 0), [])
