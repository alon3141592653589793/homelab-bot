import subprocess

TARGETS = ["nginx", "lightdm", "bluetooth", "cups"]

stopped = []
for svc in TARGETS:
    r = subprocess.run(["systemctl", "is-active", "--quiet", svc])
    if r.returncode == 0:  # active
        subprocess.run(["systemctl", "stop", svc], capture_output=True)
        stopped.append(svc)

if stopped:
    print(f"Stopped: {', '.join(stopped)}")
else:
    print("No target services were active.")