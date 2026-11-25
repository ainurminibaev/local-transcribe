import unittest

import numpy as np

from ctc_context import frame_ids
from diarize import render_transcript, timed_words, transcript_gaps, word_turns


class TranscriptAlignmentTests(unittest.TestCase):
    def test_word_crossing_two_voices_remains_whole(self):
        pieces = {0: "▁хоро", 1: "шо", 2: "▁да", 3: "▁нет"}
        words = list(timed_words(pieces, [(0.2, 0, 0.5), (0.5, 1, 0.8), (1.3, 2, 1.5), (2.1, 3, 2.3)]))
        turns = word_turns([(0, 0.6, 0), (0.6, 1.6, 1), (2.0, 2.5, 2)], words)
        self.assertEqual([(t["speaker"], t["text"]) for t in turns], [(None, "хорошо"), (1, "да"), (2, "нет")])
        self.assertIn("Говорящий неясен [00:00]: хорошо", render_transcript(turns))

    def test_overlap_and_silence_do_not_guess_a_speaker(self):
        words = [(0.5, 0.7, "да"), (1.5, 1.7, "нет")]
        turns = word_turns([(0, 1, 0), (0.3, 0.9, 1)], words)
        self.assertEqual([(t["speaker"], t["text"]) for t in turns], [(None, "да"), (None, "нет")])

    def test_gaps_distinguish_missing_speech_and_unconfirmed_speech(self):
        words = [(5.0, 5.3, "да"), (7.0, 7.4, "нет")]
        gaps = transcript_gaps(words, [(5.4, 6.7, 0)], 12)
        self.assertEqual([(g["start"], g["end"], g["speechDetected"]) for g in gaps],
                         [(0, 5, False), (5.3, 7, True), (7.4, 12, False)])


class ContextBoostTests(unittest.TestCase):
    def test_complete_term_needs_acoustic_support_and_word_boundary(self):
        pieces = {0: "▁рус", 1: "лан", 2: "лун", 3: "а"}
        audio = np.array([[0, -8, -8, -8, -8], [-8, -0.4, 0, -8, -8], [-8, -8, -8, -8, 0]])
        self.assertEqual(frame_ids(audio, pieces, 4, ["Руслан"]).tolist(), [0, 1, 4])
        audio[1, 1] = -4
        self.assertEqual(frame_ids(audio, pieces, 4, ["Руслан"]).tolist(), [0, 2, 4])
        audio[1, 1] = -0.4
        audio[2] = [-8, -8, -8, 0, -8]
        self.assertEqual(frame_ids(audio, pieces, 4, ["Руслан"]).tolist(), [0, 2, 3])


if __name__ == "__main__":
    unittest.main()
