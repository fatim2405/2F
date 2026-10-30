# Multi-stage build of apps/settlement. Binary embeds tzdata (see main.go), so
# the runtime image doesn't need it.
FROM golang:1.22 AS build
WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
RUN CGO_ENABLED=0 go build -o /out/settlement ./cmd/settlement

FROM gcr.io/distroless/static-debian12
WORKDIR /
COPY --from=build /out/settlement /settlement
ENTRYPOINT []
