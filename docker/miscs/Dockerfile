# syntax=docker/dockerfile:1.7

FROM python:3.11-slim-bookworm

WORKDIR /app

RUN pip install --no-cache-dir flask requests python-dotenv

COPY bypass403.py ./

ENV PYTHONUNBUFFERED=1

EXPOSE 25568

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:25568/health', timeout=3)"

CMD ["python", "bypass403.py"]
