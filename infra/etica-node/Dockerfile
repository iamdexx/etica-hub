FROM golang:1.22-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ make git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY go.mod go.sum /go-ethereum/
RUN cd /go-ethereum && go mod download
ADD . /go-ethereum
RUN cd /go-ethereum && go run build/ci.go install ./cmd/geth
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /go-ethereum/build/bin/geth /usr/local/bin/
EXPOSE 8545 8546 30303 30303/udp
ENTRYPOINT ["geth"]
