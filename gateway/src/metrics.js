// Minimal Prometheus text-format metrics.
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const fmt = (labels) => {
  const entries = Object.entries(labels);
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
};

export class Metrics {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.help = new Map();
  }

  counter(name, help) { this.help.set(name, ['counter', help]); if (!this.counters.has(name)) this.counters.set(name, new Map()); }
  gauge(name, help, fn) { this.help.set(name, ['gauge', help]); this.gauges.set(name, fn); }
  histogram(name, help, buckets = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120]) {
    this.help.set(name, ['histogram', help]);
    this.histograms.set(name, { buckets, series: new Map() });
  }

  inc(name, labels = {}, value = 1) {
    const series = this.counters.get(name);
    const key = JSON.stringify(labels);
    series.set(key, (series.get(key) || 0) + value);
  }

  observe(name, value, labels = {}) {
    const h = this.histograms.get(name);
    const key = JSON.stringify(labels);
    const s = h.series.get(key) || { counts: h.buckets.map(() => 0), sum: 0, count: 0 };
    h.buckets.forEach((b, i) => { if (value <= b) s.counts[i] += 1; });
    s.sum += value;
    s.count += 1;
    h.series.set(key, s);
  }

  value(name, labels = {}) {
    return this.counters.get(name)?.get(JSON.stringify(labels)) || 0;
  }

  render() {
    const out = [];
    for (const [name, [type, help]] of this.help) {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      if (type === 'counter') for (const [k, v] of this.counters.get(name)) out.push(`${name}${fmt(JSON.parse(k))} ${v}`);
      if (type === 'gauge') out.push(`${name} ${Number(this.gauges.get(name)()) || 0}`);
      if (type === 'histogram') {
        const h = this.histograms.get(name);
        for (const [k, s] of h.series) {
          const labels = JSON.parse(k);
          h.buckets.forEach((b, i) => out.push(`${name}_bucket${fmt({ ...labels, le: b })} ${s.counts[i]}`));
          out.push(`${name}_bucket${fmt({ ...labels, le: '+Inf' })} ${s.count}`, `${name}_sum${fmt(labels)} ${s.sum}`, `${name}_count${fmt(labels)} ${s.count}`);
        }
      }
    }
    return out.join('\n') + '\n';
  }
}
