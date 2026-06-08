FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/
EXPOSE 8012
CMD ["python", "-m", "uvicorn", "worker_app.sidecar:app", "--host", "0.0.0.0", "--port", "8012"]
