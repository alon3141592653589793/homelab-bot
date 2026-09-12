import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpu_profile

MARKER = "/home/alon/secure-pi-bot/.profile_override"
with open(MARKER, "w") as f:
    f.write("restricted")
cpu_profile.apply("restricted")
print("Profile: RESTRICTED | Governor: powersave | Max: 600 MHz (manual override)")