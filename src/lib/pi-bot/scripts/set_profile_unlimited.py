import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpu_profile

MARKER = "/home/alon/secure-pi-bot/.profile_override"
try:
    os.remove(MARKER)
except FileNotFoundError:
    pass
cpu_profile.apply("unlimited")
print("Profile: UNLIMITED | Governor: schedutil | Max: 1700 MHz (auto-scheduler resumed)")