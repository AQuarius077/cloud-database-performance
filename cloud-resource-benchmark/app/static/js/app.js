/**
 * app/static/js/app.js
 * --------------------
 * Cloud Resource Benchmark — Dashboard JavaScript
 *
 * Responsibilities:
 *  - Tab navigation
 *  - Live metrics polling (every 2 s)
 *  - System info fetch on load
 *  - Benchmark execution (CPU, DB, Data Processing)
 *  - Benchmark history with filters
 *  - Local vs Cloud comparison table
 *  - Chart.js charts
 */

'use strict';

// ============================================================
// Constants
// ============================================================

const API = {
  systemInfo:  '/api/system-info',
  metrics:     '/api/metrics',
  health:      '/api/health',
  benchmarks:  '/api/benchmarks',
  compare:     '/api/benchmarks/compare',
  cpuBench:    '/api/benchmark/cpu',
  dbBench:     '/api/benchmark/database',
  dataBench:   '/api/benchmark/data-processing',
};

const METRICS_INTERVAL_MS = 2000;

// Chart.js default colours
const CHART_COLORS = {
  blue:   'rgba(59,130,246,',
  cyan:   'rgba(6,182,212,',
  green:  'rgba(16,185,129,',
  orange: 'rgba(245,158,11,',
  purple: 'rgba(139,92,246,',
  red:    'rgba(239,68,68,',
};

// ============================================================
// Tab Navigation
// ============================================================

function initTabs() {
  const tabs  = document.querySelectorAll('.nav-tab');
  const panels = document.querySelectorAll('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const target = document.getElementById(tab.dataset.panel);
      if (target) target.classList.add('active');

      // Lazy-load data when switching to certain panels
      if (tab.dataset.panel === 'history-panel') loadHistory();
      if (tab.dataset.panel === 'compare-panel') loadComparison();
      if (tab.dataset.panel === 'charts-panel')  loadCharts();
    });
  });
}

// ============================================================
// Utility
// ============================================================

function el(id) { return document.getElementById(id); }

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function setBar(id, pct) {
  const node = el(id);
  if (node) node.style.width = Math.min(100, Math.max(0, pct)) + '%';
}

/** Colour the bar based on % value */
function barClass(pct) {
  if (pct < 50) return 'progress-bar__fill--green';
  if (pct < 80) return 'progress-bar__fill--orange';
  return 'progress-bar__fill--red';
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function formatBytes(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(0) + ' MB';
}

async function apiFetch(url, options = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || resp.statusText);
  }
  return resp.json();
}

// ============================================================
// Toast Notifications
// ============================================================

function showToast(message, type = 'info', durationMs = 4000) {
  const container = el('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 350);
  }, durationMs);
}

// ============================================================
// System Info (loaded once on page load)
// ============================================================

async function loadSystemInfo() {
  try {
    const d = await apiFetch(API.systemInfo);
    setText('si-hostname',   d.hostname);
    setText('si-os',         d.os);
    setText('si-python',     d.python_version);
    setText('si-cores',      d.cpu_cores);
    setText('si-total-ram',  formatBytes(d.total_ram_mb));
    setText('si-avail-ram',  formatBytes(d.available_ram_mb));
    setText('si-uptime',     formatUptime(d.uptime_seconds));
    setText('si-env',        d.environment_name);
    setText('si-config',     d.server_configuration);

    // Update header badge
    const badge = el('env-badge');
    if (badge) badge.textContent = d.environment_name;
    const cfgSpan = el('header-cfg');
    if (cfgSpan) cfgSpan.textContent = d.server_configuration;

  } catch (e) {
    console.error('Failed to load system info:', e);
  }
}

// ============================================================
// Live Metrics (polled every 2 s)
// ============================================================

function startMetricsPolling() {
  fetchMetrics();
  setInterval(fetchMetrics, METRICS_INTERVAL_MS);
}

async function fetchMetrics() {
  try {
    const d = await apiFetch(API.metrics);

    // Live metric cards
    setText('live-cpu',      d.cpu_percent.toFixed(1) + '%');
    setText('live-ram-pct',  d.ram_percent.toFixed(1) + '%');
    setText('live-ram-used', formatBytes(d.ram_used_mb));
    setText('live-ram-avail',formatBytes(d.ram_available_mb));

    // Progress bars
    const cpuBar = el('cpu-bar-fill');
    if (cpuBar) {
      cpuBar.style.width = d.cpu_percent + '%';
      cpuBar.className = 'progress-bar__fill ' + barClass(d.cpu_percent);
    }
    const ramBar = el('ram-bar-fill');
    if (ramBar) {
      ramBar.style.width = d.ram_percent + '%';
      ramBar.className = 'progress-bar__fill ' + barClass(d.ram_percent);
    }

    // Also update system info CPU/RAM inline values
    setText('si-cpu-pct',  d.cpu_percent.toFixed(1) + '%');
    setText('si-ram-pct',  d.ram_percent.toFixed(1) + '%');

  } catch (e) {
    // Silently swallow — UI stays at last values
  }
}

// ============================================================
// Option button groups (radio-like)
// ============================================================

function initOptionGroups() {
  document.querySelectorAll('.option-group').forEach(group => {
    group.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
    // Auto-select first option
    const first = group.querySelector('.option-btn');
    if (first) first.classList.add('selected');
  });
}

function getSelectedOption(groupId) {
  const group = el(groupId);
  if (!group) return null;
  const selected = group.querySelector('.option-btn.selected');
  return selected ? selected.dataset.value : null;
}

// ============================================================
// Result display helper
// ============================================================

function showResult(boxId, rows) {
  const box = el(boxId);
  if (!box) return;
  box.innerHTML = rows.map(([label, val, cls]) =>
    `<div class="result-box__row">
       <span class="result-box__label">${label}</span>
       <span class="result-box__val ${cls || ''}">${val}</span>
     </div>`
  ).join('');
  box.classList.add('visible');
}

// ============================================================
// CPU Benchmark
// ============================================================

async function runCpuBenchmark() {
  const duration = parseInt(getSelectedOption('cpu-options'), 10);
  if (!duration) { showToast('Select a duration first.', 'error'); return; }

  const btn = el('cpu-run-btn');
  const spinner = el('cpu-spinner');
  btn.disabled = true;
  spinner.classList.add('visible');
  showToast(`Starting CPU benchmark (${duration}s) …`, 'info');

  try {
    const result = await apiFetch(API.cpuBench, {
      method: 'POST',
      body: JSON.stringify({ duration }),
    });

    showResult('cpu-result', [
      ['Execution time',    result.execution_time.toFixed(3) + ' s'],
      ['Avg CPU usage',     result.avg_cpu_percent.toFixed(1) + '%'],
      ['Max CPU usage',     result.max_cpu_percent.toFixed(1) + '%'],
      ['RAM before',        formatBytes(result.ram_before_mb)],
      ['RAM after',         formatBytes(result.ram_after_mb)],
      ['CPU workers',       result.worker_count],
      ['Environment',       result.environment_name],
      ['Config',            result.server_configuration],
      ['Saved ID',          '#' + result.id],
    ]);
    showToast('CPU benchmark complete!', 'success');

  } catch (e) {
    showToast('CPU benchmark failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    spinner.classList.remove('visible');
  }
}

// ============================================================
// Database Benchmark
// ============================================================

async function runDbBenchmark() {
  const queryCount = parseInt(getSelectedOption('db-options'), 10);
  if (!queryCount) { showToast('Select a query count first.', 'error'); return; }

  const btn = el('db-run-btn');
  const spinner = el('db-spinner');
  btn.disabled = true;
  spinner.classList.add('visible');
  showToast(`Running ${queryCount.toLocaleString()} queries …`, 'info');

  try {
    const result = await apiFetch(API.dbBench, {
      method: 'POST',
      body: JSON.stringify({ query_count: queryCount }),
    });

    showResult('db-result', [
      ['Total time',        result.execution_time.toFixed(4) + ' s'],
      ['Avg query time',    result.avg_query_time_ms.toFixed(3) + ' ms'],
      ['Queries/second',    result.queries_per_second.toFixed(1)],
      ['CPU usage',         result.cpu_percent.toFixed(1) + '%'],
      ['RAM before',        formatBytes(result.ram_before_mb)],
      ['RAM after',         formatBytes(result.ram_after_mb)],
      ['Environment',       result.environment_name],
      ['Config',            result.server_configuration],
      ['Saved ID',          '#' + result.id],
    ]);
    showToast('Database benchmark complete!', 'success');

  } catch (e) {
    showToast('Database benchmark failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    spinner.classList.remove('visible');
  }
}

// ============================================================
// Data Processing Benchmark
// ============================================================

async function runDataBenchmark() {
  const size = getSelectedOption('data-options');
  if (!size) { showToast('Select a size first.', 'error'); return; }

  const btn = el('data-run-btn');
  const spinner = el('data-spinner');
  btn.disabled = true;
  spinner.classList.add('visible');
  showToast(`Running data processing benchmark (${size}) …`, 'info');

  try {
    const result = await apiFetch(API.dataBench, {
      method: 'POST',
      body: JSON.stringify({ size }),
    });

    const gflops = (result.approx_flops / result.execution_time / 1e9).toFixed(3);

    showResult('data-result', [
      ['Execution time',    result.execution_time.toFixed(4) + ' s'],
      ['Matrix size',       `${result.matrix_dimension} × ${result.matrix_dimension}`],
      ['~GFLOP/s',          gflops],
      ['CPU usage',         result.cpu_percent.toFixed(1) + '%'],
      ['RAM before',        formatBytes(result.ram_before_mb)],
      ['RAM after',         formatBytes(result.ram_after_mb)],
      ['Environment',       result.environment_name],
      ['Config',            result.server_configuration],
      ['Saved ID',          '#' + result.id],
    ]);
    showToast('Data processing benchmark complete!', 'success');

  } catch (e) {
    showToast('Data processing benchmark failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    spinner.classList.remove('visible');
  }
}

// ============================================================
// Benchmark History
// ============================================================

async function loadHistory() {
  const type  = el('filter-type')?.value  || '';
  const env   = el('filter-env')?.value   || '';
  const from  = el('filter-from')?.value  || '';
  const to    = el('filter-to')?.value    || '';

  const params = new URLSearchParams();
  if (type) params.set('test_type', type);
  if (env)  params.set('environment_name', env);
  if (from) params.set('date_from', from);
  if (to)   params.set('date_to', to);

  const tbody = el('history-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:2rem">Loading …</td></tr>';

  try {
    const rows = await apiFetch(API.benchmarks + '?' + params.toString());

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:2rem">No results yet — run a benchmark first.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const badgeCls = r.test_type === 'cpu' ? 'badge--cpu' :
                       r.test_type === 'database' ? 'badge--db' : 'badge--data';
      const ts = new Date(r.timestamp).toLocaleString();
      return `<tr>
        <td>${r.id}</td>
        <td><span class="badge ${badgeCls}">${r.test_type}</span></td>
        <td class="mono">${r.test_parameter}</td>
        <td class="mono">${r.execution_time.toFixed(4)} s</td>
        <td class="mono">${r.cpu_usage.toFixed(1)}%</td>
        <td class="mono">${r.memory_usage.toFixed(1)}%</td>
        <td><span class="badge badge--cpu" style="font-size:0.65rem">${r.environment_name}</span></td>
        <td class="text-muted" style="font-size:0.72rem">${ts}</td>
      </tr>`;
    }).join('');

  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-muted" style="text-align:center;padding:2rem">Error: ${e.message}</td></tr>`;
  }
}

// ============================================================
// Local vs Cloud Comparison
// ============================================================

async function loadComparison() {
  const container = el('compare-container');
  if (!container) return;
  container.innerHTML = '<p class="text-muted">Loading comparison data …</p>';

  try {
    const rows = await apiFetch(API.compare);

    if (!rows.length) {
      container.innerHTML = '<p class="text-muted">No data yet — run benchmarks in at least one environment first.</p>';
      return;
    }

    // Collect all unique environments
    const envs = [...new Set(rows.map(r => r.environment_name))].sort();

    // Group rows by (test_type + test_parameter)
    const groups = {};
    rows.forEach(r => {
      const key = `${r.test_type} | ${r.test_parameter}`;
      if (!groups[key]) groups[key] = { test_type: r.test_type, test_parameter: r.test_parameter, envData: {} };
      groups[key].envData[r.environment_name] = r;
    });

    // Build table
    let html = `
      <div class="compare-table-wrap">
        <table class="compare-table">
          <thead>
            <tr>
              <th>Test</th>
              ${envs.map(e => `<th>${e}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
    `;

    Object.values(groups).forEach(g => {
      // Find best (lowest) execution time across envs
      const times = envs
        .filter(e => g.envData[e])
        .map(e => parseFloat(g.envData[e].avg_execution_time));
      const best = Math.min(...times);

      html += `<tr><td>${g.test_type} — ${g.test_parameter}</td>`;
      envs.forEach(e => {
        const d = g.envData[e];
        if (!d) {
          html += `<td class="empty">—</td>`;
        } else {
          const isBest = parseFloat(d.avg_execution_time) === best;
          html += `
            <td class="${isBest ? 'best' : ''}">
              ${parseFloat(d.avg_execution_time).toFixed(4)} s<br>
              <small style="color:var(--text-muted)">cpu ${parseFloat(d.avg_cpu_usage).toFixed(1)}% | ${d.run_count} run(s)</small>
            </td>`;
        }
      });
      html += '</tr>';
    });

    html += '</tbody></table></div>';

    // Info note
    html += `<p style="margin-top:1rem;font-size:0.75rem;color:var(--text-muted)">
      ★ Best time highlighted in green. Values are averages across all runs for that configuration.
    </p>`;

    container.innerHTML = html;

  } catch (e) {
    container.innerHTML = `<p class="text-muted">Error: ${e.message}</p>`;
  }
}

// ============================================================
// Charts
// ============================================================

let charts = {};

async function loadCharts() {
  try {
    const rows = await apiFetch(API.benchmarks + '?limit=100');
    if (!rows.length) {
      el('charts-empty')?.style.setProperty('display', 'block');
      return;
    }
    el('charts-empty')?.style.setProperty('display', 'none');
    renderCpuChart(rows);
    renderRamChart(rows);
    renderExecTimeChart(rows);
    renderQpsChart(rows);
    renderTimelineChart(rows);
  } catch (e) {
    console.error('Chart load failed:', e);
  }
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function chartDefaults(type) {
  return {
    type,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 } } },
      },
      scales: {
        x: {
          ticks: { color: '#94a3b8', font: { size: 10 } },
          grid:  { color: 'rgba(30,45,85,0.6)' },
        },
        y: {
          ticks: { color: '#94a3b8', font: { size: 10 } },
          grid:  { color: 'rgba(30,45,85,0.6)' },
        },
      },
    },
  };
}

function renderCpuChart(rows) {
  destroyChart('cpuChart');
  const cpuRows = rows.filter(r => r.test_type === 'cpu').slice(0, 20).reverse();
  const labels = cpuRows.map(r => `#${r.id} ${r.test_parameter}`);
  const data   = cpuRows.map(r => r.cpu_usage);

  const cfg = chartDefaults('bar');
  cfg.data = {
    labels,
    datasets: [{
      label: 'Avg CPU %',
      data,
      backgroundColor: `${CHART_COLORS.blue}0.6)`,
      borderColor:     `${CHART_COLORS.blue}1)`,
      borderWidth: 1,
      borderRadius: 4,
    }],
  };
  cfg.options.scales.y.max = 100;
  cfg.options.scales.y.title = { display: true, text: 'CPU %', color: '#94a3b8' };

  const ctx = el('cpuChart')?.getContext('2d');
  if (ctx) charts['cpuChart'] = new Chart(ctx, cfg);
}

function renderRamChart(rows) {
  destroyChart('ramChart');
  const labels = rows.slice(0, 20).reverse().map(r => `#${r.id}`);
  const data   = rows.slice(0, 20).reverse().map(r => r.memory_usage);

  const cfg = chartDefaults('line');
  cfg.data = {
    labels,
    datasets: [{
      label: 'RAM %',
      data,
      borderColor:     `${CHART_COLORS.green}1)`,
      backgroundColor: `${CHART_COLORS.green}0.1)`,
      borderWidth: 2,
      fill: true,
      tension: 0.4,
      pointRadius: 3,
    }],
  };
  cfg.options.scales.y.max = 100;
  cfg.options.scales.y.title = { display: true, text: 'RAM %', color: '#94a3b8' };

  const ctx = el('ramChart')?.getContext('2d');
  if (ctx) charts['ramChart'] = new Chart(ctx, cfg);
}

function renderExecTimeChart(rows) {
  destroyChart('execChart');
  const types = ['cpu', 'database', 'data-processing'];
  const colors = [CHART_COLORS.blue, CHART_COLORS.cyan, CHART_COLORS.purple];

  const datasets = types.map((t, i) => {
    const typeRows = rows.filter(r => r.test_type === t).slice(0, 15).reverse();
    return {
      label: t,
      data: typeRows.map(r => ({ x: `#${r.id}`, y: r.execution_time })),
      backgroundColor: `${colors[i]}0.7)`,
      borderColor:     `${colors[i]}1)`,
      borderWidth: 1,
      borderRadius: 4,
    };
  });

  const allIds = rows.slice(0, 20).reverse().map(r => `#${r.id}`);

  const cfg = chartDefaults('bar');
  cfg.data = { labels: allIds, datasets };
  cfg.options.scales.y.title = { display: true, text: 'Seconds', color: '#94a3b8' };

  const ctx = el('execChart')?.getContext('2d');
  if (ctx) charts['execChart'] = new Chart(ctx, cfg);
}

function renderQpsChart(rows) {
  destroyChart('qpsChart');
  const dbRows = rows.filter(r => {
    return r.test_type === 'database' && r.extra_metrics?.queries_per_second != null;
  }).slice(0, 20).reverse();

  if (!dbRows.length) return;

  const labels = dbRows.map(r => `#${r.id} ${r.test_parameter}`);
  const data   = dbRows.map(r => r.extra_metrics.queries_per_second);

  const cfg = chartDefaults('bar');
  cfg.data = {
    labels,
    datasets: [{
      label: 'Queries / second',
      data,
      backgroundColor: `${CHART_COLORS.cyan}0.6)`,
      borderColor:     `${CHART_COLORS.cyan}1)`,
      borderWidth: 1,
      borderRadius: 4,
    }],
  };
  cfg.options.scales.y.title = { display: true, text: 'Q/s', color: '#94a3b8' };

  const ctx = el('qpsChart')?.getContext('2d');
  if (ctx) charts['qpsChart'] = new Chart(ctx, cfg);
}

function renderTimelineChart(rows) {
  destroyChart('timelineChart');
  const sorted = rows.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const labels = sorted.map(r => new Date(r.timestamp).toLocaleDateString());
  const data   = sorted.map(r => r.execution_time);

  const cfg = chartDefaults('line');
  cfg.data = {
    labels,
    datasets: [{
      label: 'Execution time (s)',
      data,
      borderColor:     `${CHART_COLORS.orange}1)`,
      backgroundColor: `${CHART_COLORS.orange}0.1)`,
      borderWidth: 2,
      fill: true,
      tension: 0.3,
      pointRadius: 3,
    }],
  };
  cfg.options.scales.y.title = { display: true, text: 'Seconds', color: '#94a3b8' };

  const ctx = el('timelineChart')?.getContext('2d');
  if (ctx) charts['timelineChart'] = new Chart(ctx, cfg);
}

// ============================================================
// Initialise everything on DOMContentLoaded
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initOptionGroups();
  loadSystemInfo();
  startMetricsPolling();

  // Wire benchmark buttons
  el('cpu-run-btn')?.addEventListener('click',  runCpuBenchmark);
  el('db-run-btn')?.addEventListener('click',   runDbBenchmark);
  el('data-run-btn')?.addEventListener('click', runDataBenchmark);

  // History filter button
  el('apply-filters-btn')?.addEventListener('click', loadHistory);
});
