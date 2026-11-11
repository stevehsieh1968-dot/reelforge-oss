FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
ENV TTS_HOST=0.0.0.0 TTS_PORT=5100 TTS_VOICE_DIR=/data/voices
EXPOSE 5100
CMD ["python", "server.py"]
