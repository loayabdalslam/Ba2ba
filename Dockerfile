# Bee2Bee node image. Build: docker build -t bee2bee-node .
# Run a model-less relay:      docker run -p 4003:4003 -p 4002:4002 bee2bee-node
# Serve Ollama on the host:    docker run --network host -e OLLAMA_HOST=http://localhost:11434 bee2bee-node serve-ollama --model llama3.2
FROM python:3.12-slim AS build
WORKDIR /src
RUN pip install --no-cache-dir build
COPY pyproject.toml README.md LICENSE ./
COPY bee2bee ./bee2bee
RUN python -m build --wheel --outdir /dist

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BEE2BEE_HOME=/data \
    BEE2BEE_HOST=0.0.0.0 \
    BEE2BEE_PORT=4003 \
    BEE2BEE_API_PORT=4002 \
    BEE2BEE_UPNP=false \
    BEE2BEE_LOG_JSON=true
COPY --from=build /dist/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm /tmp/*.whl \
    && useradd --system --uid 10001 --home-dir /data --create-home bee2bee
USER bee2bee
VOLUME ["/data"]
EXPOSE 4003 4002
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"BEE2BEE_PORT\"]}/healthz', timeout=4)"
ENTRYPOINT ["bee2bee"]
CMD ["relay"]
