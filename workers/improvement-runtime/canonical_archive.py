"""Normalize only the outer image tar; content-addressed blobs stay byte-identical."""
import pathlib
import sys
import tarfile


def normalize(source, destination):
    with tarfile.open(source, "r:") as archive:
        members = archive.getmembers()
        names = set()
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or member.name in names or not (member.isfile() or member.isdir()):
                raise ValueError("invalid image archive member")
            names.add(member.name)
        with tarfile.open(destination, "w", format=tarfile.GNU_FORMAT) as output:
            for member in sorted(members, key=lambda item: item.name):
                member.uid = member.gid = member.mtime = 0
                member.uname = member.gname = ""
                member.pax_headers = {}
                member.mode = 0o755 if member.isdir() else 0o644
                output.addfile(member, archive.extractfile(member) if member.isfile() else None)


if __name__ == "__main__":
    normalize(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
