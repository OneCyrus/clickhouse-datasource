// Command otelgen sends realistic OpenTelemetry traces and logs for a small
// microservice shop to an OTLP/gRPC endpoint, for developing the logs and
// traces editors against the ClickHouse exporter schema.
//
// It first backfills -backfill of history (spans and logs carry past
// timestamps), then keeps sending live traffic at -rps requests per second.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	otellog "go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/metric"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type service struct {
	name, version, lang string
	tracer              trace.Tracer
	logger              otellog.Logger
	tp                  *sdktrace.TracerProvider
	lp                  *sdklog.LoggerProvider
	mp                  interface {
		ForceFlush(context.Context) error
		Shutdown(context.Context) error
	}
	m *meters
}

var (
	endpoint = flag.String("endpoint", "localhost:4317", "OTLP gRPC endpoint")
	backfill = flag.Duration("backfill", 3*time.Hour, "history to backfill before going live")
	bfRate   = flag.Int("backfill-rpm", 40, "requests per minute of history to backfill")
	rps      = flag.Float64("rps", 2, "live requests per second (0 to stop after backfill)")
)

var services = map[string]*service{}

func newService(ctx context.Context, name, version, lang, env, pod string) *service {
	res := resource.NewWithAttributes("https://opentelemetry.io/schemas/1.37.0",
		attribute.String("service.name", name),
		attribute.String("service.namespace", "shop"),
		attribute.String("service.version", version),
		attribute.String("service.instance.id", pod),
		attribute.String("deployment.environment.name", env),
		attribute.String("telemetry.sdk.language", lang),
		attribute.String("telemetry.sdk.name", "opentelemetry"),
		attribute.String("k8s.namespace.name", "shop-"+env),
		attribute.String("k8s.pod.name", pod),
		attribute.String("k8s.deployment.name", name),
		attribute.String("k8s.cluster.name", "eu-central-1-prod"),
		attribute.String("host.name", "ip-10-0-"+fmt.Sprint(rand.Intn(9))+"-"+fmt.Sprint(10+rand.Intn(200))+".internal"),
		attribute.String("cloud.provider", "aws"),
		attribute.String("cloud.region", "eu-central-1"),
	)
	te, err := otlptracegrpc.New(ctx, otlptracegrpc.WithEndpoint(*endpoint), otlptracegrpc.WithInsecure())
	if err != nil {
		log.Fatal(err)
	}
	le, err := otlploggrpc.New(ctx, otlploggrpc.WithEndpoint(*endpoint), otlploggrpc.WithInsecure())
	if err != nil {
		log.Fatal(err)
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithBatcher(te, sdktrace.WithMaxQueueSize(100000), sdktrace.WithMaxExportBatchSize(2000)))
	lp := sdklog.NewLoggerProvider(sdklog.WithResource(res), sdklog.WithProcessor(sdklog.NewBatchProcessor(le, sdklog.WithMaxQueueSize(100000), sdklog.WithExportMaxBatchSize(2000))))
	scope := "shop/" + name
	mp, ms := newMeterProvider(ctx, res, name)
	return &service{name: name, version: version, lang: lang, tp: tp, lp: lp, mp: mp, m: ms,
		tracer: tp.Tracer(scope, trace.WithInstrumentationVersion("1.4.0")),
		logger: lp.Logger(scope, otellog.WithInstrumentationVersion("1.4.0"))}
}

// clock is the simulated time of the current request.
type clock struct{ t time.Time }

func (c *clock) adv(d time.Duration) time.Time { c.t = c.t.Add(d); return c.t }

func ms(lo, hi float64) time.Duration {
	return time.Duration((lo + rand.Float64()*(hi-lo)) * float64(time.Millisecond))
}

func (s *service) emit(ctx context.Context, at time.Time, sev otellog.Severity, body string, attrs ...attribute.KeyValue) {
	var r otellog.Record
	r.SetTimestamp(at)
	r.SetObservedTimestamp(at.Add(ms(1, 20)))
	r.SetSeverity(sev)
	r.SetSeverityText(sevText(sev))
	r.SetBody(attribute.StringValue(body))
	for _, a := range attrs {
		if a.Key == "event.name" {
			r.SetEventName(a.Value.AsString())
			continue
		}
		r.AddAttributes(a)
	}
	s.logger.Emit(ctx, r)
}

func sevText(s otellog.Severity) string {
	switch {
	case s >= otellog.SeverityFatal:
		return "FATAL"
	case s >= otellog.SeverityError:
		return "ERROR"
	case s >= otellog.SeverityWarn:
		return "WARN"
	case s >= otellog.SeverityInfo:
		return "INFO"
	case s >= otellog.SeverityDebug:
		return "DEBUG"
	default:
		return "TRACE"
	}
}

func start(ctx context.Context, s *service, name string, kind trace.SpanKind, at time.Time, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	return s.tracer.Start(ctx, name, trace.WithSpanKind(kind), trace.WithTimestamp(at), trace.WithAttributes(attrs...))
}

func fail(span trace.Span, at time.Time, errType, msg, stack string) {
	span.AddEvent("exception", trace.WithTimestamp(at), trace.WithAttributes(
		attribute.String("exception.type", errType),
		attribute.String("exception.message", msg),
		attribute.String("exception.stacktrace", stack),
	))
	span.SetAttributes(attribute.String("error.type", errType))
	span.SetStatus(codes.Error, msg)
}

var users = []string{"u-1042", "u-2210", "u-3381", "u-4007", "u-5120", "u-6631", "u-7314"}
var products = []string{"OLJCESPC7Z", "66VCHSJNUP", "1YMWWN1N4O", "L9ECAV7KIM", "2ZYFJ3GM2N", "0PUK6V6EV0", "LS4PSXUNUM", "9SIQT8TOJO"}

type route struct {
	method, route string
	weight        int
	handler       func(ctx context.Context, c *clock, req *request)
}

type request struct {
	user, product string
	status        int
	err           bool
}

func httpServerAttrs(method, rt, target string) []attribute.KeyValue {
	return []attribute.KeyValue{
		attribute.String("http.request.method", method),
		attribute.String("http.route", rt),
		attribute.String("url.path", target),
		attribute.String("url.scheme", "https"),
		attribute.String("server.address", "shop.example.com"),
		attribute.String("network.protocol.version", "1.1"),
		attribute.String("user_agent.original", pick("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15", "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0", "okhttp/4.12.0", "python-requests/2.32.3")),
		attribute.String("client.address", fmt.Sprintf("203.0.113.%d", rand.Intn(250))),
	}
}

func pick(xs ...string) string { return xs[rand.Intn(len(xs))] }

func dbSpan(ctx context.Context, s *service, c *clock, system, op, table, stmt string, lo, hi float64, failP float64) bool {
	_, sp := start(ctx, s, op+" "+table, trace.SpanKindClient, c.adv(ms(0.2, 1)),
		attribute.String("db.system.name", system),
		attribute.String("db.operation.name", op),
		attribute.String("db.collection.name", table),
		attribute.String("db.namespace", "shop"),
		attribute.String("db.query.text", stmt),
		attribute.String("server.address", system+".shop.svc.cluster.local"),
		attribute.Int("server.port", map[string]int{"postgresql": 5432, "redis": 6379}[system]),
	)
	began := c.t
	record := func(end time.Time, errType string) {
		if live {
			attrs := []attribute.KeyValue{attribute.String("db.system.name", system), attribute.String("db.operation.name", op),
				attribute.String("db.collection.name", table)}
			if errType != "" {
				attrs = append(attrs, attribute.String("error.type", errType))
			}
			s.m.dbDuration.Record(ctx, end.Sub(began).Seconds(), metric.WithAttributes(attrs...))
		}
	}
	end := c.adv(ms(lo, hi))
	if rand.Float64() < failP {
		end = c.adv(ms(500, 3000))
		fail(sp, end, "context.DeadlineExceeded", "context deadline exceeded", "goroutine 1 [running]:\nmain.query()\n\t/app/db.go:88 +0x1b2")
		sp.End(trace.WithTimestamp(end))
		record(end, "context.DeadlineExceeded")
		return false
	}
	sp.End(trace.WithTimestamp(end))
	record(end, "")
	return true
}

func grpcCall(ctx context.Context, from, to *service, c *clock, svc, method string, body func(ctx context.Context) (codes.Code, string)) (codes.Code, string) {
	cctx, client := start(ctx, from, svc+"/"+method, trace.SpanKindClient, c.adv(ms(0.3, 1)),
		attribute.String("rpc.system", "grpc"), attribute.String("rpc.service", svc), attribute.String("rpc.method", method),
		attribute.String("server.address", to.name), attribute.Int("server.port", 8080))
	serverStart := c.adv(ms(0.2, 1.5))
	sctx, server := start(cctx, to, svc+"/"+method, trace.SpanKindServer, serverStart,
		attribute.String("rpc.system", "grpc"), attribute.String("rpc.service", svc), attribute.String("rpc.method", method))
	code, msg := body(sctx)
	rpcCode := 0
	if code == codes.Error {
		rpcCode = 13
		server.SetStatus(codes.Error, msg)
		client.SetStatus(codes.Error, msg)
	}
	server.SetAttributes(attribute.Int("rpc.grpc.status_code", rpcCode))
	client.SetAttributes(attribute.Int("rpc.grpc.status_code", rpcCode))
	serverEnd := c.adv(ms(0.1, 1))
	server.End(trace.WithTimestamp(serverEnd))
	if live {
		to.m.rpcDuration.Record(ctx, serverEnd.Sub(serverStart).Seconds(), metric.WithAttributes(
			attribute.String("rpc.system", "grpc"), attribute.String("rpc.service", svc), attribute.String("rpc.method", method),
			attribute.Int("rpc.grpc.status_code", rpcCode)))
	}
	client.End(trace.WithTimestamp(c.adv(ms(0.2, 1.5))))
	return code, msg
}

func routes() []route {
	fe, cat, cart, chk, pay, ship, email, rec := services["frontend"], services["product-catalog"], services["cart"], services["checkout"], services["payment"], services["shipping"], services["email"], services["recommendation"]
	return []route{
		{"GET", "/api/products/{id}", 40, func(ctx context.Context, c *clock, r *request) {
			code, msg := grpcCall(ctx, fe, cat, c, "oteldemo.ProductCatalogService", "GetProduct", func(ctx context.Context) (codes.Code, string) {
				if !dbSpan(ctx, cat, c, "postgresql", "SELECT", "products", "SELECT id, name, price_units, categories FROM products WHERE id = $1", 0.8, 6, 0.01) {
					cat.emit(ctx, c.t, otellog.SeverityError, "failed to load product "+r.product+": context deadline exceeded",
						attribute.String("product.id", r.product), attribute.String("exception.type", "context.DeadlineExceeded"), attribute.String("code.function.name", "catalog.(*Server).GetProduct"))
					return codes.Error, "product lookup timed out"
				}
				if r.product == "9SIQT8TOJO" && rand.Float64() < 0.3 {
					cat.emit(ctx, c.t, otellog.SeverityWarn, "product "+r.product+" not found in catalog", attribute.String("product.id", r.product))
					return codes.Error, "product not found"
				}
				cat.emit(ctx, c.t, otellog.SeverityDebug, "served product "+r.product+" from database", attribute.String("product.id", r.product), attribute.Bool("cache.hit", false))
				return codes.Unset, ""
			})
			if code == codes.Error {
				r.err = true
				if strings.Contains(msg, "not found") {
					r.status = 404
				} else {
					r.status = 504
				}
			}
			grpcCall(ctx, fe, rec, c, "oteldemo.RecommendationService", "ListRecommendations", func(ctx context.Context) (codes.Code, string) {
				c.adv(ms(2, 25))
				rec.emit(ctx, c.t, otellog.SeverityInfo, fmt.Sprintf("returning %d recommendations for product %s", 3+rand.Intn(4), r.product), attribute.String("product.id", r.product), attribute.String("app.recommendation.algorithm", pick("collaborative", "popular")))
				return codes.Unset, ""
			})
		}},
		{"GET", "/api/cart", 25, func(ctx context.Context, c *clock, r *request) {
			grpcCall(ctx, fe, cart, c, "oteldemo.CartService", "GetCart", func(ctx context.Context) (codes.Code, string) {
				dbSpan(ctx, cart, c, "redis", "HGETALL", "cart", "HGETALL cart:"+r.user, 0.1, 2, 0)
				cart.emit(ctx, c.t, otellog.SeverityInfo, "GetCart called for user "+r.user, attribute.String("app.user.id", r.user))
				return codes.Unset, ""
			})
		}},
		{"POST", "/api/cart", 15, func(ctx context.Context, c *clock, r *request) {
			grpcCall(ctx, fe, cart, c, "oteldemo.CartService", "AddItem", func(ctx context.Context) (codes.Code, string) {
				q := 1 + rand.Intn(4)
				dbSpan(ctx, cart, c, "redis", "HSET", "cart", fmt.Sprintf("HSET cart:%s %s %d", r.user, r.product, q), 0.1, 2, 0)
				cart.emit(ctx, c.t, otellog.SeverityInfo, fmt.Sprintf("AddItem called with user %s, product %s, quantity %d", r.user, r.product, q),
					attribute.String("app.user.id", r.user), attribute.String("product.id", r.product), attribute.Int("app.product.quantity", q))
				return codes.Unset, ""
			})
		}},
		{"POST", "/api/checkout", 12, func(ctx context.Context, c *clock, r *request) {
			order := fmt.Sprintf("ord-%06d", rand.Intn(999999))
			code, msg := grpcCall(ctx, fe, chk, c, "oteldemo.CheckoutService", "PlaceOrder", func(ctx context.Context) (codes.Code, string) {
				chk.emit(ctx, c.t, otellog.SeverityInfo, "placing order "+order+" for user "+r.user, attribute.String("app.order.id", order), attribute.String("app.user.id", r.user))
				code, msg := grpcCall(ctx, chk, pay, c, "oteldemo.PaymentService", "Charge", func(ctx context.Context) (codes.Code, string) {
					amount := 10 + rand.Float64()*400
					c.adv(ms(20, 180))
					if rand.Float64() < 0.07 {
						card := pick("visa", "mastercard", "amex")
						pay.emit(ctx, c.t, otellog.SeverityError, "payment declined: insufficient funds for card ending "+fmt.Sprint(1000+rand.Intn(8999)),
							attribute.String("app.payment.card_type", card), attribute.Float64("app.payment.amount", amount), attribute.String("exception.type", "PaymentDeclinedError"))
						sp := trace.SpanFromContext(ctx)
						fail(sp, c.t, "PaymentDeclinedError", "payment declined: insufficient funds", "PaymentDeclinedError: payment declined\n    at charge (/app/charge.js:42:11)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)")
						return codes.Error, "payment declined"
					}
					if rand.Float64() < 0.03 {
						pay.emit(ctx, c.t, otellog.SeverityWarn, "retrying charge after upstream 503 from payment gateway", attribute.Int("app.retry.attempt", 1))
						c.adv(ms(200, 900))
					}
					pay.emit(ctx, c.t, otellog.SeverityInfo, fmt.Sprintf("charged %.2f EUR successfully", amount), attribute.Float64("app.payment.amount", amount), attribute.String("app.payment.currency", "EUR"))
					return codes.Unset, ""
				})
				if code == codes.Error {
					chk.emit(ctx, c.t, otellog.SeverityError, "failed to place order "+order+": "+msg, attribute.String("app.order.id", order), attribute.String("error.type", "PaymentDeclinedError"))
					return code, msg
				}
				dbSpan(ctx, chk, c, "postgresql", "INSERT", "orders", "INSERT INTO orders (id, user_id, total) VALUES ($1, $2, $3)", 1, 12, 0.005)
				grpcCall(ctx, chk, ship, c, "oteldemo.ShippingService", "ShipOrder", func(ctx context.Context) (codes.Code, string) {
					c.adv(ms(5, 60))
					ship.emit(ctx, c.t, otellog.SeverityInfo, "shipment scheduled with tracking id "+fmt.Sprintf("1Z%08X", rand.Uint32()), attribute.String("app.order.id", order))
					return codes.Unset, ""
				})
				// Async: checkout publishes, email consumes.
				pctx, prod := start(ctx, chk, "publish orders", trace.SpanKindProducer, c.adv(ms(0.2, 1)),
					attribute.String("messaging.system", "kafka"), attribute.String("messaging.destination.name", "orders"), attribute.String("messaging.operation.type", "send"))
				prod.End(trace.WithTimestamp(c.adv(ms(1, 6))))
				cctx, cons := start(pctx, email, "process orders", trace.SpanKindConsumer, c.adv(ms(5, 80)),
					attribute.String("messaging.system", "kafka"), attribute.String("messaging.destination.name", "orders"), attribute.String("messaging.operation.type", "process"),
					attribute.String("messaging.consumer.group.name", "email-service"))
				c.adv(ms(10, 120))
				if rand.Float64() < 0.02 {
					email.emit(cctx, c.t, otellog.SeverityError, "SMTP connection refused: dial tcp 10.0.4.17:587: connect: connection refused", attribute.String("exception.type", "SMTPConnectError"))
					fail(cons, c.t, "SMTPConnectError", "connection refused", "Traceback (most recent call last):\n  File \"/app/email.py\", line 51, in send\nsmtplib.SMTPConnectError: connection refused")
				} else {
					email.emit(cctx, c.t, otellog.SeverityInfo, "order confirmation sent to customer", attribute.String("app.order.id", order))
				}
				cons.End(trace.WithTimestamp(c.t))
				return codes.Unset, ""
			})
			if code == codes.Error {
				r.err, r.status = true, 402
				_ = msg
			}
		}},
		{"GET", "/healthz", 8, func(ctx context.Context, c *clock, r *request) { c.adv(ms(0.1, 0.8)) }},
	}
}

func handle(ctx context.Context, rts []route, total int, at time.Time) {
	n := rand.Intn(total)
	var rt route
	for _, r := range rts {
		if n < r.weight {
			rt = r
			break
		}
		n -= r.weight
	}
	fe := services["frontend"]
	c := &clock{t: at}
	req := &request{user: users[rand.Intn(len(users))], product: products[rand.Intn(len(products))], status: 200}
	target := strings.Replace(rt.route, "{id}", req.product, 1)
	sctx, sp := start(ctx, fe, rt.method+" "+rt.route, trace.SpanKindServer, c.t, httpServerAttrs(rt.method, rt.route, target)...)
	if rt.method == "POST" {
		req.status = 201
	}
	if live {
		fe.m.httpActive.Add(ctx, 1, metric.WithAttributes(attribute.String("http.request.method", rt.method)))
	}
	rt.handler(sctx, c, req)
	end := c.adv(ms(0.3, 3))
	if live {
		fe.m.httpActive.Add(ctx, -1, metric.WithAttributes(attribute.String("http.request.method", rt.method)))
		fe.m.httpDuration.Record(ctx, end.Sub(at).Seconds(), metric.WithAttributes(
			attribute.String("http.request.method", rt.method), attribute.String("http.route", rt.route),
			attribute.Int("http.response.status_code", req.status), attribute.String("url.scheme", "https")))
		if rt.route == "/api/checkout" {
			chk := services["checkout"]
			if req.status == 201 {
				chk.m.orders.Add(ctx, 1, metric.WithAttributes(attribute.String("app.payment.currency", "EUR")))
			} else if req.status == 402 {
				services["payment"].m.declined.Add(ctx, 1, metric.WithAttributes(attribute.String("app.payment.card_type", pick("visa", "mastercard", "amex"))))
			}
		}
	}
	sp.SetAttributes(attribute.Int("http.response.status_code", req.status), attribute.String("app.user.id", req.user))
	if req.status >= 500 {
		sp.SetStatus(codes.Error, "")
		sp.SetAttributes(attribute.String("error.type", fmt.Sprint(req.status)))
	}
	if rt.route != "/healthz" {
		sev := otellog.SeverityInfo
		if req.status >= 500 {
			sev = otellog.SeverityError
		} else if req.status >= 400 {
			sev = otellog.SeverityWarn
		}
		dur := end.Sub(at)
		fe.emit(sctx, end, sev, fmt.Sprintf("%s %s %d %.1fms", rt.method, target, req.status, float64(dur.Microseconds())/1000),
			attribute.String("http.request.method", rt.method), attribute.String("http.route", rt.route), attribute.Int("http.response.status_code", req.status),
			attribute.String("url.path", target), attribute.String("event.name", "http.access"))
	}
	sp.End(trace.WithTimestamp(end))
}

// background emits logs not tied to any request.
func background(ctx context.Context, at time.Time) {
	switch rand.Intn(12) {
	case 0:
		services["cart"].emit(ctx, at, otellog.SeverityDebug, "redis pool stats: active=4 idle=12 waits=0")
	case 1:
		services["product-catalog"].emit(ctx, at, otellog.SeverityInfo, "refreshed product cache with 10 entries", attribute.Int("cache.size", 10))
	case 2:
		services["frontend"].emit(ctx, at, otellog.SeverityTrace, "gc pause 1.2ms heap=48MB")
	case 3:
		services["shipping"].emit(ctx, at, otellog.SeverityWarn, "carrier API latency above threshold: 1840ms", attribute.Int("app.carrier.latency_ms", 1840))
	case 4:
		if rand.Intn(20) == 0 {
			services["payment"].emit(ctx, at, otellog.SeverityFatal, "unable to load TLS certificate: open /etc/tls/tls.crt: no such file or directory", attribute.String("exception.type", "Error"))
		}
	case 5:
		services["recommendation"].emit(ctx, at, otellog.SeverityInfo, "model reloaded version=2026-11-01 features=128")
	}
}

func main() {
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	defs := []struct{ name, ver, lang, pod string }{
		{"frontend", "2.3.1", "nodejs", "frontend-7d9f8c6b5-x2k9p"},
		{"product-catalog", "1.8.0", "go", "product-catalog-5b7d9-qwz4r"},
		{"cart", "1.12.4", "dotnet", "cart-6c8f7d5c9-m7n2b"},
		{"checkout", "1.5.2", "go", "checkout-84f6c9d7f-lp3sd"},
		{"payment", "3.0.0", "nodejs", "payment-5f9b8c7d6-tt8vq"},
		{"shipping", "0.9.7", "rust", "shipping-7c5d9f8b4-h4jkl"},
		{"email", "1.1.0", "python", "email-6b7c8d9f5-r9w2e"},
		{"recommendation", "2.0.3", "python", "recommendation-58d9c7-zz1aa"},
	}
	for _, d := range defs {
		env := "production"
		services[d.name] = newService(ctx, d.name, d.ver, d.lang, env, d.pod)
	}
	rts := routes()
	total := 0
	for _, r := range rts {
		total += r.weight
	}

	now := time.Now()
	if *backfill > 0 {
		n := int(backfill.Minutes()) * *bfRate
		log.Printf("backfilling %d requests over %s", n, *backfill)
		for i := 0; i < n; i++ {
			at := now.Add(-*backfill).Add(time.Duration(rand.Int63n(int64(*backfill))))
			handle(ctx, rts, total, at)
			if i%3 == 0 {
				background(ctx, at)
			}
		}
	}
	flush := func() {
		for _, s := range services {
			_ = s.tp.ForceFlush(ctx)
			_ = s.lp.ForceFlush(ctx)
			_ = s.mp.ForceFlush(ctx)
		}
	}
	flush()
	log.Printf("backfill done")
	live = true
	if *rps > 0 {
		t := time.NewTicker(time.Duration(float64(time.Second) / *rps))
		defer t.Stop()
	loop:
		for {
			select {
			case <-ctx.Done():
				break loop
			case <-t.C:
				handle(ctx, rts, total, time.Now())
				background(ctx, time.Now())
			}
		}
	}
	for _, s := range services {
		_ = s.tp.Shutdown(context.Background())
		_ = s.lp.Shutdown(context.Background())
		_ = s.mp.Shutdown(context.Background())
	}
}
