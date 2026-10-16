FROM ghcr.io/rivet-dev/rivet/builder-base-windows-mingw@sha256:68af55fa3f0d0b253b3ed2f8ba9f61e51f289a2e0581961797dcb326262b9988
RUN rustup toolchain install 1.91.1 --profile minimal && rustup default 1.91.1 && rustup target add x86_64-pc-windows-gnu
