"""Test-only diagnostic entrypoint; never included in the staged product image."""
import errno
import json
import os
import pathlib
import socket
import subprocess
import sys


def validate_limits(cpu, memory, swap, pids):
    quota, period = map(int, cpu.split())
    assert period > 0 and quota == 2 * period, "CPU cgroup limit changed"
    assert int(memory) == 2147483648, "Memory cgroup limit changed"
    assert int(swap) == 0, "Swap must be disabled"
    assert int(pids) == 128, "PID cgroup limit changed"


def probe(config):
    import resource

    cgroup = pathlib.Path("/sys/fs/cgroup")
    validate_limits(*(cgroup.joinpath(name).read_text().strip() for name in (
        "cpu.max", "memory.max", "memory.swap.max", "pids.max")))
    status = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
    assert status["NoNewPrivs"].strip() == "1"
    assert status["Seccomp"].strip() == "2"
    assert int(status["CapEff"].strip(), 16) == 0
    assert os.getuid() == 10001 and os.getgid() == 10001
    assert "LUMEN_ACCEPTANCE_HOST_ONLY_TOKEN" not in os.environ
    for name in ["/var/run/docker.sock", "/run/docker.sock", *config["hostPaths"]]:
        try:
            with open(name, "rb"):
                raise AssertionError("Host canary or Docker socket is readable")
        except OSError as error:
            assert error.errno in (errno.ENOENT, errno.EACCES, errno.ENOTDIR)
    scratch = pathlib.Path("/scratch/lumen-probe")
    scratch.write_text("#!/bin/sh\nexit 0\n")
    scratch.chmod(0o700)
    assert scratch.read_text() == "#!/bin/sh\nexit 0\n"
    try:
        subprocess.run([str(scratch)], check=True)
        raise AssertionError("Scratch execution must be refused")
    except OSError as error:
        assert error.errno == errno.EACCES
    finally:
        scratch.unlink()
    for name, size in (("/scratch", 268435456), ("/tmp", 67108864)):
        volume = os.statvfs(name)
        assert volume.f_blocks * volume.f_frsize == size
    try:
        with open("/lumen-probe-root-write", "wb"):
            raise AssertionError("Root write must be refused")
    except OSError as error:
        assert error.errno in (errno.EROFS, errno.EACCES)
    assert resource.getrlimit(resource.RLIMIT_NOFILE) == (256, 256)
    handles = []
    try:
        while len(handles) <= 256:
            handles.append(os.open("/dev/null", os.O_RDONLY))
        raise AssertionError("File descriptor limit was not enforced")
    except OSError as error:
        assert error.errno == errno.EMFILE
    finally:
        for handle in handles:
            os.close(handle)
    # Use the actual host interface address supplied by the owned listener.
    with socket.socket() as connection:
        connection.settimeout(2)
        try:
            connection.connect((config["hostAddress"], config["hostPort"]))
            raise AssertionError("Network-none guest reached host canary")
        except OSError:
            pass
    return {"cgroupLimits": True, "kernelConfinement": True, "hostFileAndSocketDenied": True,
            "hostTokenAbsent": True, "scratchWritableAndNoexec": True, "rootWriteDenied": True,
            "tmpfsLimits": True, "nofileEnforced": True, "hostConnectionDenied": True}


if __name__ == "__main__":
    print(json.dumps(probe(json.loads(sys.argv[1])), sort_keys=True))
