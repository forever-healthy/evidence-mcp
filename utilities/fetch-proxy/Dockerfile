# The fetch-proxy stage of evidence-mcp's download (src/fetchproxy.ts):
# a plain HTTP forward proxy, so the server's fetch leaves from this host's IP.
# No auth: compose publishes it on the tailnet IP only.
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
EXPOSE 8888
# Listens on $PORT (compose: the published port), 8888 by default.
CMD ["sh", "-c", "sed -i \"s/^Port .*/Port ${PORT:-8888}/\" /etc/tinyproxy/tinyproxy.conf && exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf"]
