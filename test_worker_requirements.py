import unittest
from importlib.metadata import PackageNotFoundError
from unittest.mock import patch
from scripts.setup_worker import requirements_satisfied
class WorkerRequirementTests(unittest.TestCase):
 def test_missing_unpinned_package_requires_installation(self):
  with patch('importlib.metadata.version',side_effect=PackageNotFoundError('missing')):
   self.assertFalse(requirements_satisfied('missing'))
 def test_existing_package_must_match_release_constraint(self):
  with patch('importlib.metadata.version',return_value='1.0.0'):
   self.assertTrue(requirements_satisfied('package==1.0.0'))
   self.assertFalse(requirements_satisfied('package==2.0.0'))
if __name__=='__main__':unittest.main()
