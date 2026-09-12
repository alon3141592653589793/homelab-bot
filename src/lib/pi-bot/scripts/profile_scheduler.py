import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cpu_profile

# Reconcile markers + clock, apply the winning target. Instant-exit if the
# current sysfs already matches. Owner of all sysfs writes: cpu_profile.apply.
cpu_profile.apply(cpu_profile.desired_target())