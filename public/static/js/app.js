/**
 * public/static/js/app.js
 * -----------------------
 * Бұлттық деректер базасының өнімділігін оңтайландыру әдістерін зерттеу
 * Master's Research & Performance Benchmarking Dashboard
 */

'use strict';

const API = {
  systemInfo:     '/api/system-info',
  metrics:        '/api/metrics',
  health:         '/api/health',
  databaseStatus: '/api/database/status',
  dbConnect:      '/api/database/connect',
  index:          '/api/database/index',
  indexCompare:   '/api/benchmark/database/compare-index',
  datasetSeed:    '/api/benchmark/dataset-seed',
  benchmarks:     '/api/benchmarks',
  compare:        '/api/benchmarks/compare',
  dbBench:        '/api/benchmark/database',
  poolBench:      '/api/benchmark/connection-pool',
  report:         '/api/report',
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
// Utility & Toast
// ============================================================

function el(id) { return document.getElementById(id); }

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function formatBytes(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(0) + ' MB';
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function barClass(pct) {
  if (pct < 50) return 'progress-bar__fill--green';
  if (pct < 80) return 'progress-bar__fill--orange';
  return 'progress-bar__fill--red';
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

function showToast(message, type = 'info', durationMs = 4000) {
  const container = el('toast-container');
  if (!container) return;
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

      if (tab.dataset.panel === 'history-panel') loadHistory();
      if (tab.dataset.panel === 'compare-panel') loadComparison();
      if (tab.dataset.panel === 'charts-panel')  loadCharts();
      if (tab.dataset.panel === 'report-panel')  loadAcademicReport();
      setTimeout(renderMath, 60);
    });
  });
}

// ============================================================
// Option Groups
// ============================================================

function initOptionGroups() {
  document.querySelectorAll('.option-group').forEach(group => {
    group.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.option-btn').forEach(b => {
          b.classList.remove('selected');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('selected');
        btn.setAttribute('aria-pressed', 'true');
      });
    });
    const first = group.querySelector('.option-btn');
    if (first && !group.querySelector('.option-btn.selected')) {
      first.classList.add('selected');
      first.setAttribute('aria-pressed', 'true');
    }
  });
}

function renderMath() {
  if (typeof renderMathInElement === 'function') {
    try {
      renderMathInElement(document.body, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false
      });
    } catch (e) {
      console.warn('Math rendering notice:', e);
    }
  }
}

function getSelectedOption(groupId) {
  const group = el(groupId);
  if (!group) return null;
  const selected = group.querySelector('.option-btn.selected');
  return selected ? selected.dataset.value : null;
}

// ============================================================
// System Info & Live Host Metrics
// ============================================================

async function loadSystemInfo() {
  try {
    const d = await apiFetch(API.systemInfo);
    setText('si-hostname',   d.hostname);
    setText('si-os',         d.os);
    setText('si-python',     d.node_version);
    setText('si-cores',      d.cpu_cores);
    setText('si-total-ram',  formatBytes(d.total_ram_mb));
    setText('si-avail-ram',  formatBytes(d.available_ram_mb));
    setText('si-uptime',     formatUptime(d.uptime_seconds));
    setText('si-env',        d.environment_name);
    setText('si-config',     d.server_configuration);

    const badge = el('env-badge');
    if (badge) badge.textContent = d.environment_name;
    const cfgSpan = el('header-cfg');
    if (cfgSpan) cfgSpan.textContent = d.server_configuration;
  } catch (e) {
    console.error('System info fetch failed:', e);
  }
}

function startMetricsPolling() {
  fetchMetrics();
  setInterval(fetchMetrics, METRICS_INTERVAL_MS);
}

async function fetchMetrics() {
  try {
    const d = await apiFetch(API.metrics);
    setText('live-cpu',      d.cpu_percent.toFixed(1) + '%');
    setText('live-ram-pct',  d.ram_percent.toFixed(1) + '%');
    setText('live-ram-used', formatBytes(d.ram_used_mb));
    setText('live-ram-avail',formatBytes(d.ram_available_mb));

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
  } catch {}
}

// ============================================================
// Database Status & Connection Management
// ============================================================

async function loadDatabaseStatus() {
  const badge = el('db-status-badge');
  try {
    const res = await fetch(API.databaseStatus);
    const d = await res.json();

    if (res.ok && d.connected && d.database) {
      if (badge) badge.innerHTML = '<span class="badge badge--db" style="background:rgba(16,185,129,0.15);color:var(--accent-green)">Қосылған (Connected)</span>';
      setText('db-stat-name', d.database.name || '—');
      setText('db-stat-version', (d.database.version || '').split(' on ')[0] || 'PostgreSQL');
      setText('db-stat-size', `${d.database.size_mb} MB`);
      setText('db-stat-conns', `${d.database.active_connections}`);
      setText('db-stat-pool', `pg.Pool (max: ${d.database.pool_max})`);
      setText('db-stat-users', d.database.counts ? Number(d.database.counts.users_count).toLocaleString() : '0');
      setText('db-stat-orders', d.database.counts ? Number(d.database.counts.orders_count).toLocaleString() : '0');
      setText('db-stat-results', d.database.counts ? Number(d.database.counts.results_count).toLocaleString() : '0');

      const isIndexActive = d.database.benchmark_index_exists;
      const isCompActive = d.database.composite_index_exists;
      setText('db-stat-index', `B-tree: ${isIndexActive ? 'Бар' : 'Жоқ'} | Композиттік: ${isCompActive ? 'Бар' : 'Жоқ'}`);
      const statusEl = el('index-toggle-status');
      if (statusEl) {
        statusEl.textContent = `B-tree (email): ${isIndexActive ? 'БЕЛСЕНДІ' : 'ӨШІРУЛІ'} | Композиттік: ${isCompActive ? 'БЕЛСЕНДІ' : 'ӨШІРУЛІ'}`;
        statusEl.style.color = (isIndexActive || isCompActive) ? 'var(--accent-green)' : 'var(--accent-orange)';
      }
    } else {
      if (badge) badge.innerHTML = '<span class="badge badge--cpu" style="background:rgba(239,68,68,0.15);color:var(--accent-red)">Ажыратылған (Offline)</span>';
      setText('db-stat-name', 'Офлайн');
      setText('db-stat-version', d.error || 'DATABASE_URL орнатылмаған');
      setText('db-stat-size', '—');
      setText('db-stat-conns', '0');
      setText('db-stat-users', '—');
      setText('db-stat-orders', '—');
      setText('db-stat-results', '—');
      setText('db-stat-index', '—');
      const statusEl = el('index-toggle-status');
      if (statusEl) {
        statusEl.textContent = 'Офлайн (Деректер базасы қосылмаған)';
        statusEl.style.color = 'var(--text-secondary)';
      }
    }
  } catch (err) {
    if (badge) badge.innerHTML = '<span class="badge badge--cpu" style="background:rgba(239,68,68,0.15);color:var(--accent-red)">Қате</span>';
    setText('db-stat-name', 'Қолжетімсіз');
    setText('db-stat-version', err.message);
  }
}

async function handleDatabaseConnect() {
  const input = el('db-url-input');
  if (!input) return;
  const url = input.value.trim();
  if (!url) {
    showToast('DATABASE_URL енгізіңіз (мысалы, Neon connection string)', 'error');
    return;
  }

  showToast('PostgreSQL қосылымы тексерілуде (SELECT 1) …', 'info');
  try {
    const res = await apiFetch(API.dbConnect, {
      method: 'POST',
      body: JSON.stringify({ database_url: url }),
    });
    showToast(res.message, 'success');
    input.value = '';
    loadDatabaseStatus();
  } catch (err) {
    showToast('Қосылу қатесі: ' + err.message, 'error');
  }
}

// ============================================================
// Dataset Seeding (generate_series in PostgreSQL)
// ============================================================

async function runDatasetSeed() {
  const size = parseInt(getSelectedOption('seed-options'), 10);
  if (!size) {
    showToast('Деректер жинағының көлемін таңдаңыз.', 'error');
    return;
  }

  const confirmMsg = `Назар аударыңыз! ${size.toLocaleString()} жазба генерациялау алдында бұрынғы кестелер толық тазартылады (TRUNCATE ... CASCADE). Жалғастырасыз ба?`;
  if (!confirm(confirmMsg)) {
    return;
  }

  const btn = el('seed-run-btn');
  const spinner = el('seed-spinner');
  btn.disabled = true;
  spinner?.classList.add('visible');
  showToast(`PostgreSQL-де ${size.toLocaleString()} жазба generate_series арқылы толтырылуда …`, 'info');

  try {
    const result = await apiFetch(API.datasetSeed, {
      method: 'POST',
      body: JSON.stringify({ dataset_size: size }),
    });

    showResult('seed-result', [
      ['Күйі (Status)',          result.status === 'ok' ? 'Сәтті аяқталды' : 'Қате', result.status === 'ok' ? 'result-box__val--good' : 'result-box__val--warn'],
      ['Деректер көлемі',       result.dataset_size.toLocaleString() + ' жазба'],
      ['Пайдаланушылар саны',   result.users_inserted.toLocaleString()],
      ['Тапсырыстар саны',      result.orders_inserted.toLocaleString()],
      ['Енгізу уақыты',         result.insertion_time_ms + ' мс'],
      ['База көлемі (кейін)',   result.database_size_after_mb + ' MB'],
      ['СУБД әдісі',            'PostgreSQL (generate_series)'],
    ]);

    showToast(`Сәтті енгізілді: ${result.users_inserted.toLocaleString()} жазба (${result.insertion_time_ms} мс)!`, 'success');
    loadDatabaseStatus();
  } catch (e) {
    showResult('seed-result', [
      ['Күйі',         'Сәтсіз', 'result-box__val--warn'],
      ['Қате сипаттамасы', e.message],
    ]);
    showToast('Деректерді толтыру сәтсіз: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    spinner?.classList.remove('visible');
  }
}

// ============================================================
// Real SQL Database Benchmark (6 Scenarios)
// ============================================================

async function runDbBenchmark() {
  const scenario = getSelectedOption('db-scenario-options') || 'by_id';
  const repetitions = parseInt(getSelectedOption('db-options') || '30', 10);

  const btn = el('db-run-btn');
  const spinner = el('db-spinner');
  btn.disabled = true;
  spinner?.classList.add('visible');
  showToast(`Нақты SQL сұраныстар орындалуда (${scenario}, ${repetitions} қайталау) …`, 'info');

  try {
    const result = await apiFetch(API.dbBench, {
      method: 'POST',
      body: JSON.stringify({ scenario, repetitions }),
    });

    const rows = [
      ['Сценарий (Scenario)',            result.scenario],
      ['Қайталаулар саны (Repetitions)',  result.stats.count + ' сұраныс'],
      ['Клиенттік толық кідіріс (Mean)',  result.stats.mean_ms.toFixed(2) + ' мс (Желі + DB)'],
      ['Медиана (P50)',                  result.stats.median_ms.toFixed(2) + ' мс'],
      ['P95 Кідіріс',                    result.stats.p95_ms.toFixed(2) + ' мс'],
      ['Min / Max кідіріс',              result.stats.min_ms.toFixed(2) + ' / ' + result.stats.max_ms.toFixed(2) + ' мс'],
      ['Стандартты ауытқу (σ)',          (result.stats.std_dev_ms || 0).toFixed(2) + ' мс'],
      ['95% Сенімділік аралығы (CI)',    '±' + (result.stats.confidence_interval_95 || 0).toFixed(2) + ' мс'],
      ['Клиенттік өткізу (QPS)',         result.stats.qps.toFixed(1) + ' сұраныс/сек (1/RTT шектеулі)'],
    ];

    if (result.explain_diagnostic) {
      rows.push(['EXPLAIN түйіні', result.explain_diagnostic.node_type]);
      rows.push(['PostgreSQL серверлік өңдеу', result.explain_diagnostic.execution_time_ms.toFixed(3) + ' мс (DB ядросы)']);
      rows.push(['PostgreSQL серверлік жоспарлау', result.explain_diagnostic.planning_time_ms.toFixed(3) + ' мс']);
    }

    if (result.baseline_network_rtt_ms) {
      rows.push(['Желілік кідіріс (WAN RTT)', '~' + result.baseline_network_rtt_ms.toFixed(1) + ' мс (Қазақстан ⇄ Франкфурт)']);
    }
    if (result.connection_acquisition_ms !== undefined) {
      rows.push(['Байланысты алу уақыты (Pool acquire)', result.connection_acquisition_ms.toFixed(2) + ' мс']);
    }
    if (result.server_estimated_qps) {
      rows.push(['Серверлік теориялық QPS', result.server_estimated_qps.toLocaleString() + ' сұр/сек (желісіз ядро)']);
    }

    rows.push(['Жалпы сынақ уақыты (Wall-clock)', result.execution_time.toFixed(4) + ' сек']);
    rows.push(['Сақталған нәтиже ID', '#' + result.id]);

    showResult('db-result', rows);
    showToast('SQL бенчмаркі сәтті аяқталып, нәтиже PostgreSQL-де сақталды!', 'success');
    loadDatabaseStatus();
  } catch (e) {
    showResult('db-result', [
      ['Күйі', 'Қате', 'result-box__val--warn'],
      ['Қате сипаттамасы', e.message],
    ]);
    showToast('SQL бенчмарк қатесі: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    spinner?.classList.remove('visible');
  }
}

// ============================================================
// Controlled Index Optimization Experiment (Single & Composite B-Tree)
// ============================================================

function renderIndexLiveChart(result) {
  destroyChart('indexLiveChart');
  const ctx = el('indexLiveChart')?.getContext('2d');
  if (!ctx) return;

  const aMean = result.configuration_a_unindexed.stats.mean_ms;
  const bMean = result.configuration_b_indexed.stats.mean_ms;
  const aP95  = result.configuration_a_unindexed.stats.p95_ms;
  const bP95  = result.configuration_b_indexed.stats.p95_ms;

  charts['indexLiveChart'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [
        `A: ${result.configuration_a_unindexed.scan_type || 'Seq Scan'}`,
        `B: ${result.configuration_b_indexed.scan_type || 'Index Scan'}`,
      ],
      datasets: [
        {
          label: 'Орташа кідіріс (Mean ms)',
          data: [aMean, bMean],
          backgroundColor: ['rgba(239, 68, 68, 0.65)', 'rgba(16, 185, 129, 0.65)'],
          borderColor:     ['rgba(239, 68, 68, 1)',    'rgba(16, 185, 129, 1)'],
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: 'P95 кідіріс (ms)',
          data: [aP95, bP95],
          backgroundColor: ['rgba(245, 158, 11, 0.55)', 'rgba(6, 182, 212, 0.55)'],
          borderColor:     ['rgba(245, 158, 11, 1)',    'rgba(6, 182, 212, 1)'],
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { family: 'Inter', size: 10 } } },
      },
      scales: {
        y: {
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(30,45,85,0.6)' },
          title: { display: true, text: 'Кідіріс (мс)', color: '#94a3b8' },
        },
        x: {
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(30,45,85,0.6)' },
        },
      },
    },
  });
}

async function runIndexBenchmark() {
  const indexType = getSelectedOption('index-type-options') || 'single_btree';
  const repetitions = parseInt(getSelectedOption('index-exp-options') || '15', 10);

  const btn = el('index-run-btn');
  const spinner = el('index-spinner');
  btn.disabled = true;
  spinner?.classList.add('visible');
  const typeLabel = indexType === 'composite_btree' ? 'Композиттік B-tree' : 'B-tree (email)';
  showToast(`Бақыланатын индекстеу сынағы басталды (${typeLabel}, ${repetitions} сұраныс) …`, 'info');

  try {
    const result = await apiFetch(API.indexCompare, {
      method: 'POST',
      body: JSON.stringify({ repetitions, index_type: indexType }),
    });

    const speedup = result.comparison.speedup_multiplier;
    const speedupClass = speedup > 1.2 ? 'result-box__val--good' : '';

    const rows = [
      ['Эксперимент түрі',               result.experiment_name],
      ['Мақсатты индекс',                result.target_index_name],
      ['Серверлік ядро жеделдеуі (EXPLAIN)', `${result.comparison.server_time_speedup}x есе жеделдеді`, 'result-box__val--good'],
      ['Клиенттік толық жеделдеу (Желімен)', `${speedup}x (${result.comparison.latency_reduction_pct}% жақсару)`, speedupClass],
      ['QPS өсімі',                       `+${result.comparison.qps_increase_pct}%`],
      ['A: Индекссіз сервер уақыты',     `${result.configuration_a_unindexed.explain.execution_time_ms.toFixed(3)} мс (${result.configuration_a_unindexed.scan_type})`],
      ['B: Индекстелген сервер уақыты',   `${result.configuration_b_indexed.explain.execution_time_ms.toFixed(3)} мс (${result.configuration_b_indexed.scan_type})`],
      ['A: Индекссіз клиент кідірісі',    `${result.configuration_a_unindexed.stats.mean_ms.toFixed(2)} мс (P95: ${result.configuration_a_unindexed.stats.p95_ms.toFixed(2)} мс, ${result.configuration_a_unindexed.stats.qps} QPS)`],
      ['B: Индекстелген клиент кідірісі', `${result.configuration_b_indexed.stats.mean_ms.toFixed(2)} мс (P95: ${result.configuration_b_indexed.stats.p95_ms.toFixed(2)} мс, ${result.configuration_b_indexed.stats.qps} QPS)`],
      ['Индекс құру ұзақтығы',            `${result.configuration_b_indexed.index_creation_duration_ms} мс (өлшемге қосылмаған)`],
      ['Сынақталған сұраныстар',         `${result.repetitions} сұраныс әр конфигурацияда`],
      ['Нәтижелер сақталған ID',          `#${result.configuration_a_unindexed.persisted_id} & #${result.configuration_b_indexed.persisted_id}`],
    ];

    showResult('index-result', rows);
    renderIndexLiveChart(result);

    showToast(`Индекстеу қорытындысы: ${result.comparison.summary}`, 'success');
    loadDatabaseStatus();
  } catch (e) {
    showResult('index-result', [
      ['Күйі', 'Қате', 'result-box__val--warn'],
      ['Қате сипаттамасы', e.message],
    ]);
    showToast('Индекстеу эксперименті қатесі: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    spinner?.classList.remove('visible');
  }
}

async function handleIndexAction(action, index_type = 'single') {
  const isComp = index_type === 'composite';
  const name = isComp ? 'idx_db_benchmark_users_status_created' : 'idx_db_benchmark_users_email';
  showToast(`${action === 'create' ? 'Индекс құрылуда' : 'Индекс өшірілуде'} (${name}) …`, 'info');
  try {
    const res = await apiFetch(API.index, {
      method: 'POST',
      body: JSON.stringify({ action, index_type }),
    });
    showToast(`Индекс ${res.action} сәтті аяқталды (${res.duration_ms || 0} мс)!`, 'success');
    loadDatabaseStatus();
  } catch (err) {
    showToast(`Индекс қатесі: ${err.message}`, 'error');
  }
}

// ============================================================
// Phase 6: Connection Pooling Benchmark
// ============================================================

async function runConnectionPoolBenchmark() {
  const concurrency = parseInt(getSelectedOption('pool-concurrency-options') || '10', 10);
  const repetitionsPerWorker = parseInt(getSelectedOption('pool-rep-options') || '5', 10);

  const btn = el('pool-run-btn');
  const spinner = el('pool-spinner');
  btn.disabled = true;
  spinner?.classList.add('visible');
  showToast(`Байланыстар пулының эксперименті басталды (${concurrency} ағын, 1, 5, 10, 20 пул көлемдері) …`, 'info');

  try {
    const result = await apiFetch(API.poolBench, {
      method: 'POST',
      body: JSON.stringify({
        pool_sizes: [1, 5, 10, 20],
        concurrency,
        repetitions_per_worker: repetitionsPerWorker,
      }),
    });

    const rows = [
      ['Эксперимент',            result.experiment_name],
      ['Параллель ағындар',      `${result.concurrency} ағын`],
      ['Оңтайлы пул көлемі',     `${result.optimal_pool_size} байланыс`, 'result-box__val--good'],
      ['Максималды Throughput',  `${result.max_qps} QPS`, 'result-box__val--good'],
    ];

    result.steps.forEach(s => {
      rows.push([
        `Пул көлемі ${s.pool_size}`,
        `${s.qps} QPS (Орташа: ${s.stats.mean_ms} мс, P95: ${s.stats.p95_ms} мс)`
      ]);
    });

    rows.push(['Ғылыми қорытынды', result.scientific_summary_kz]);
    showResult('pool-result', rows);

    showToast('Байланыстар пулының сынағы сәтті аяқталды!', 'success');
  } catch (e) {
    showResult('pool-result', [
      ['Күйі', 'Қате', 'result-box__val--warn'],
      ['Қате сипаттамасы', e.message],
    ]);
    showToast('Пул сынағы қатесі: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    spinner?.classList.remove('visible');
  }
}

// ============================================================
// Benchmark History & Comparison
// ============================================================

async function loadHistory() {
  const type  = el('filter-type')?.value  || '';
  const env   = el('filter-env')?.value   || '';

  const params = new URLSearchParams();
  if (type) params.set('test_type', type);
  if (env)  params.set('environment_name', env);

  const tbody = el('history-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:2rem">Жүктелуде …</td></tr>';

  try {
    const rows = await apiFetch(API.benchmarks + '?' + params.toString());

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:2rem">Нәтижелер табылмады — алдымен бенчмаркті орындаңыз.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const badgeCls = r.test_type === 'cpu' ? 'badge--cpu' : 'badge--db';
      const ts = new Date(r.timestamp).toLocaleString();
      return `<tr>
        <td>#${r.id}</td>
        <td><span class="badge ${badgeCls}">${r.test_type}</span></td>
        <td class="mono">${r.test_parameter}</td>
        <td class="mono">${r.execution_time.toFixed(4)} s</td>
        <td class="mono">${(r.cpu_usage || 0).toFixed(1)}%</td>
        <td class="mono">${(r.memory_usage || 0).toFixed(1)}%</td>
        <td><span class="badge badge--cpu" style="font-size:0.65rem">${r.environment_name}</span></td>
        <td class="text-muted" style="font-size:0.72rem">${ts}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-muted" style="text-align:center;padding:2rem">Қате: ${e.message}</td></tr>`;
  }
}

async function loadComparison() {
  const container = el('compare-container');
  if (!container) return;
  container.innerHTML = '<p class="text-muted">Салыстыру деректері есептелуде …</p>';

  try {
    const rows = await apiFetch(API.compare);

    if (!rows.length) {
      container.innerHTML = '<p class="text-muted">Әзірге өлшенген деректер жоқ. Бенчмарктерді орындаңыз.</p>';
      return;
    }

    const envs = [...new Set(rows.map(r => r.environment_name))].sort();

    // Group rows
    const groups = {};
    rows.forEach(r => {
      const key = `${r.test_type} | ${r.test_parameter}`;
      if (!groups[key]) groups[key] = { test_type: r.test_type, test_parameter: r.test_parameter, envData: {} };
      groups[key].envData[r.environment_name] = r;
    });

    let html = `
      <div class="compare-table-wrap">
        <table class="compare-table">
          <thead>
            <tr>
              <th>Сынақ түрі және параметр</th>
              ${envs.map(e => `<th>${e}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
    `;

    Object.values(groups).forEach(g => {
      html += `<tr><td>${g.test_type} — ${g.test_parameter}</td>`;
      envs.forEach(e => {
        const d = g.envData[e];
        if (!d) {
          html += `<td class="empty">Өлшенбеген</td>`;
        } else {
          html += `
            <td>
              ${parseFloat(d.avg_execution_time).toFixed(4)} s<br>
              <small style="color:var(--text-muted)">QPS: ${d.avg_qps || '—'} | ${d.run_count} сынақ</small>
            </td>`;
        }
      });
      html += '</tr>';
    });

    html += '</tbody></table></div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<p class="text-muted">Қате: ${e.message}</p>`;
  }
}

// ============================================================
// Charts
// ============================================================

let charts = {};

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

async function loadCharts() {
  try {
    const rows = await apiFetch(API.benchmarks + '?limit=100');
    renderIndexEffectChart(rows);
    renderPoolChart(rows);
    renderQpsChart(rows);
    renderRamChart(rows);
    renderTimelineChart(rows);
  } catch (e) {
    console.error('Chart load failed:', e);
  }
}

function renderIndexEffectChart(rows) {
  destroyChart('indexChart');
  const indexRows = rows.filter(r => r.test_type?.startsWith('index_') || r.test_parameter?.includes('index_exp'));
  const unindexed = indexRows.filter(r => r.test_parameter?.includes('unindexed') || r.test_type?.includes('unindexed'));
  const indexed = indexRows.filter(r => r.test_parameter?.includes('indexed') && !r.test_parameter?.includes('unindexed'));

  const avgUnindexed = unindexed.length
    ? unindexed.reduce((a, b) => a + (b.extra_metrics?.avg_query_time_ms || b.execution_time * 1000), 0) / unindexed.length
    : 0;
  const avgIndexed = indexed.length
    ? indexed.reduce((a, b) => a + (b.extra_metrics?.avg_query_time_ms || b.execution_time * 1000), 0) / indexed.length
    : 0;

  const ctx = el('indexChart')?.getContext('2d');
  if (!ctx) return;

  charts['indexChart'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Индекссіз (Seq Scan)', 'Индекспен (Index Scan)'],
      datasets: [{
        label: 'Орташа кідіріс (мс)',
        data: [avgUnindexed.toFixed(2), avgIndexed.toFixed(2)],
        backgroundColor: [
          'rgba(239, 68, 68, 0.65)',
          'rgba(16, 185, 129, 0.65)',
        ],
        borderColor: [
          'rgba(239, 68, 68, 1)',
          'rgba(16, 185, 129, 1)',
        ],
        borderWidth: 1,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(30,45,85,0.6)' },
          title: { display: true, text: 'Кідіріс (мс)', color: '#94a3b8' },
        },
        x: {
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(30,45,85,0.6)' },
        },
      },
    },
  });
}

function renderPoolChart(rows) {
  destroyChart('poolChart');
  const poolRows = rows.filter(r => r.test_type === 'connection_pooling');
  const steps = [];
  if (poolRows.length && poolRows[0].extra_metrics?.steps) {
    steps.push(...poolRows[0].extra_metrics.steps);
  }

  const labels = steps.length ? steps.map(s => `Пул: ${s.pool_size}`) : ['Пул: 1', 'Пул: 5', 'Пул: 10', 'Пул: 20'];
  const data = steps.length ? steps.map(s => s.qps) : [0, 0, 0, 0];

  const ctx = el('poolChart')?.getContext('2d');
  if (!ctx) return;

  charts['poolChart'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Өткізу қабілеті (QPS)',
        data,
        borderColor: 'rgba(139, 92, 246, 1)',
        backgroundColor: 'rgba(139, 92, 246, 0.15)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(30,45,85,0.6)' },
          title: { display: true, text: 'QPS', color: '#94a3b8' },
        },
        x: {
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(30,45,85,0.6)' },
        },
      },
    },
  });
}

function renderQpsChart(rows) {
  destroyChart('qpsChart');
  const dbRows = rows.filter(r => r.test_type === 'database' && r.extra_metrics?.queries_per_second != null).slice(0, 15).reverse();
  const labels = dbRows.map(r => `#${r.id} ${r.test_parameter.split(' ')[0]}`);
  const data   = dbRows.map(r => r.extra_metrics.queries_per_second);

  const ctx = el('qpsChart')?.getContext('2d');
  if (!ctx) return;

  charts['qpsChart'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Сұраныс / секунд (QPS)',
        data,
        backgroundColor: `${CHART_COLORS.cyan}0.65)`,
        borderColor:     `${CHART_COLORS.cyan}1)`,
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(30,45,85,0.6)' } },
        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(30,45,85,0.6)' } },
      },
    },
  });
}

function renderRamChart(rows) {
  destroyChart('ramChart');
  const last20 = rows.slice(0, 20).reverse();
  const labels = last20.map(r => `#${r.id}`);
  const data   = last20.map(r => r.memory_usage);

  const ctx = el('ramChart')?.getContext('2d');
  if (!ctx) return;

  charts['ramChart'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Хост RAM %',
        data,
        borderColor:     `${CHART_COLORS.green}1)`,
        backgroundColor: `${CHART_COLORS.green}0.1)`,
        borderWidth: 2,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { max: 100, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(30,45,85,0.6)' } },
        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(30,45,85,0.6)' } },
      },
    },
  });
}

function renderTimelineChart(rows) {
  destroyChart('timelineChart');
  const sorted = rows.slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()).slice(-20);
  const labels = sorted.map(r => new Date(r.timestamp).toLocaleTimeString());
  const data   = sorted.map(r => r.execution_time);

  const ctx = el('timelineChart')?.getContext('2d');
  if (!ctx) return;

  charts['timelineChart'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Орындалу ұзақтығы (сек)',
        data,
        borderColor:     `${CHART_COLORS.orange}1)`,
        backgroundColor: `${CHART_COLORS.orange}0.1)`,
        borderWidth: 2,
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(30,45,85,0.6)' } },
        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(30,45,85,0.6)' } },
      },
    },
  });
}

// ============================================================
// Academic Research Report (Kazakh)
// ============================================================

async function loadAcademicReport() {
  try {
    const d = await apiFetch(API.report);
    setText('report-date', new Date(d.generated_at).toLocaleString());
    setText('rep-db-engine', d.database_infrastructure.engine);
    setText('rep-db-size', `${d.database_infrastructure.size_on_disk_mb} MB`);
    setText('rep-users-count', Number(d.database_infrastructure.users_count).toLocaleString());
    setText('rep-experiments-count', `${d.total_persisted_experiments} сынақ`);
    setText('rep-summary-text', d.experiment_summary_kz);
  } catch (err) {
    setText('rep-summary-text', 'Есепті жүктеу сәтсіз: ' + err.message);
  }
}

// ============================================================
// Initialization
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initOptionGroups();
  loadSystemInfo();
  loadDatabaseStatus();
  startMetricsPolling();

  // Wire buttons
  el('btn-save-db-url')?.addEventListener('click', handleDatabaseConnect);
  el('btn-toggle-show-url')?.addEventListener('click', () => {
    const input = el('db-url-input');
    if (!input) return;
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    el('btn-toggle-show-url').textContent = isPass ? 'Жасыру' : 'Көрсету';
  });

  el('seed-run-btn')?.addEventListener('click', runDatasetSeed);
  el('db-run-btn')?.addEventListener('click', runDbBenchmark);
  el('index-run-btn')?.addEventListener('click', runIndexBenchmark);
  el('btn-create-index')?.addEventListener('click', () => handleIndexAction('create', 'single'));
  el('btn-drop-index')?.addEventListener('click', () => handleIndexAction('drop', 'single'));
  el('btn-create-comp-index')?.addEventListener('click', () => handleIndexAction('create', 'composite'));
  el('btn-drop-comp-index')?.addEventListener('click', () => handleIndexAction('drop', 'composite'));
  el('pool-run-btn')?.addEventListener('click', runConnectionPoolBenchmark);
  el('apply-filters-btn')?.addEventListener('click', loadHistory);
  el('btn-refresh-report')?.addEventListener('click', () => {
    loadAcademicReport().then(() => setTimeout(renderMath, 100));
  });
  el('btn-print-report')?.addEventListener('click', () => window.print());

  // Render LaTeX math formulas across panels
  setTimeout(renderMath, 200);
  setTimeout(renderMath, 1000);
});
