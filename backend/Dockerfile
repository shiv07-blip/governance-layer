FROM python:3.12-slim

WORKDIR /app

# Dependencies in their own layer so source edits do not trigger a reinstall.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY policies ./policies
COPY agents ./agents

# Run unprivileged. The control plane holds revocation authority for the whole
# fleet, so it is the last place to leave a root process.
RUN useradd --create-home --uid 10001 governance
USER governance

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health',timeout=2).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
