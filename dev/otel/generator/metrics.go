package main

import (
	"context"
	"log"
	"math/rand"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
)

// meters are the instruments of one service, named after the semantic conventions.
type meters struct {
	httpDuration metric.Float64Histogram
	httpActive   metric.Int64UpDownCounter
	rpcDuration  metric.Float64Histogram
	dbDuration   metric.Float64Histogram
	orders       metric.Int64Counter
	declined     metric.Int64Counter
}

// live is false while backfilling: metrics carry the time they are recorded at, so history is
// only sent for traces and logs.
var live bool

func newMeterProvider(ctx context.Context, res *resource.Resource, name string) (*sdkmetric.MeterProvider, *meters) {
	exp, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithEndpoint(*endpoint), otlpmetricgrpc.WithInsecure())
	if err != nil {
		log.Fatal(err)
	}
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp, sdkmetric.WithInterval(10*time.Second))))
	m := mp.Meter("shop/"+name, metric.WithInstrumentationVersion("1.4.0"))
	secondsBuckets := metric.WithExplicitBucketBoundaries(0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10)
	ms := &meters{}
	ms.httpDuration, _ = m.Float64Histogram("http.server.request.duration", metric.WithUnit("s"),
		metric.WithDescription("Duration of HTTP server requests."), secondsBuckets)
	ms.httpActive, _ = m.Int64UpDownCounter("http.server.active_requests", metric.WithUnit("{request}"),
		metric.WithDescription("Number of active HTTP server requests."))
	ms.rpcDuration, _ = m.Float64Histogram("rpc.server.call.duration", metric.WithUnit("s"),
		metric.WithDescription("Measures the duration of inbound RPC."), secondsBuckets)
	ms.dbDuration, _ = m.Float64Histogram("db.client.operation.duration", metric.WithUnit("s"),
		metric.WithDescription("Duration of database client operations."), secondsBuckets)
	ms.orders, _ = m.Int64Counter("app.orders.placed", metric.WithUnit("{order}"),
		metric.WithDescription("Orders placed successfully."))
	ms.declined, _ = m.Int64Counter("app.payment.declined", metric.WithUnit("{payment}"),
		metric.WithDescription("Payments declined by the provider."))

	// Process gauges, a random walk per service.
	memory := 80e6 + rand.Float64()*120e6
	cpu := 0.05 + rand.Float64()*0.2
	queue := 0.0
	memGauge, _ := m.Int64ObservableGauge("process.memory.usage", metric.WithUnit("By"),
		metric.WithDescription("The amount of physical memory in use."))
	cpuGauge, _ := m.Float64ObservableGauge("process.cpu.utilization", metric.WithUnit("1"),
		metric.WithDescription("Difference in process.cpu.time since the last measurement, divided by the elapsed time and number of CPUs available to the process."))
	queueGauge, _ := m.Int64ObservableGauge("app.queue.depth", metric.WithUnit("{message}"),
		metric.WithDescription("Messages waiting in the service's work queue."))
	_, _ = m.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		memory = clamp(memory+(rand.Float64()-0.48)*4e6, 40e6, 600e6)
		cpu = clamp(cpu+(rand.Float64()-0.5)*0.04, 0.01, 0.95)
		queue = clamp(queue+(rand.Float64()-0.5)*6, 0, 200)
		o.ObserveInt64(memGauge, int64(memory), metric.WithAttributes(attribute.String("process.memory.type", "rss")))
		o.ObserveFloat64(cpuGauge, cpu, metric.WithAttributes(attribute.String("cpu.mode", "user")))
		o.ObserveFloat64(cpuGauge, cpu/3, metric.WithAttributes(attribute.String("cpu.mode", "system")))
		o.ObserveInt64(queueGauge, int64(queue))
		return nil
	}, memGauge, cpuGauge, queueGauge)
	return mp, ms
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
