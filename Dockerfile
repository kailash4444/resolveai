FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app
COPY requirements-real.txt .
RUN pip install --no-cache-dir -r requirements-real.txt
COPY realapp ./realapp

RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080
CMD ["uvicorn", "realapp.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
