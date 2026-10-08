# Build context is constructed by stage-improvement.ts and contains no Lumen/evaluator files.
FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS prime
ARG SOURCE_DATE_EPOCH=1791353246
WORKDIR /source
COPY prime/ ./
RUN cargo fetch --locked && cargo build --release --locked --offline --bin prime-agent

FROM python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2 AS python-dependencies
ARG SOURCE_DATE_EPOCH=1791353246
COPY requirements.lock /requirements.lock
RUN python -m pip download --require-hashes --only-binary=:all: --dest /wheels -r /requirements.lock
RUN python -m pip install --no-index --find-links=/wheels --require-hashes --no-compile -r /requirements.lock

FROM python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2
ARG SOURCE_DATE_EPOCH=1791353246
LABEL dev.lumen.improvement.protocol="1" dev.lumen.improvement.prime="0.9.8" dev.lumen.improvement.revision="2ed835646120f79562407879ff19e8860623775c"
COPY --from=prime /source/target/release/prime-agent /usr/local/bin/prime-agent
COPY --from=python-dependencies /usr/local/lib/python3.12/site-packages/ /usr/local/lib/python3.12/site-packages/
COPY prime/prime-agent-runtime/src/ /opt/prime-runtime/
COPY bridge.py /opt/lumen/bridge.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/scratch/home TMPDIR=/scratch/tmp PRIME_AGENT_KERNEL_PYTHON=/usr/local/bin/python3 PYTHONPATH=/opt/prime-runtime
USER 10001:10001
WORKDIR /scratch
ENTRYPOINT ["python3", "/opt/lumen/bridge.py"]
