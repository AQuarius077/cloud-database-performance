import {
  checkDatabaseConnection,
  getDatabaseStatus,
  seedResearchDataset,
  pgPoolMax,
  sanitizeDbError,
  getPool,
  checkBenchmarkIndexExists,
  createBenchmarkIndex,
  createCompositeBenchmarkIndex,
  dropBenchmarkIndex,
  runRealSqlBenchmark,
  runControlledIndexExperiment,
  runConnectionPoolingExperiment,
  getPersistedBenchmarkResults,
  calculateLatencyStats,
  acquireBenchmarkLock,
  releaseBenchmarkLock,
  BENCHMARK_INDEX_NAME,
  BENCHMARK_COMPOSITE_INDEX_NAME,
} from '../db.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log('--- Ғылыми зерттеу платформасының интеграциялық тестілері ---');

  // Test 1: Configuration & Security
  console.log('\nTest Suite 1: Конфигурация және қауіпсіздік');
  assert(pgPoolMax === 20 || pgPoolMax > 0, `Байланыстар пулының максималды өлшемі дұрыс (мән: ${pgPoolMax})`);
  const sampleSecretErr = new Error('Connection failed: postgresql://admin:secretPass123@ep-test.neon.tech/neondb');
  const sanitized = sanitizeDbError(sampleSecretErr);
  assert(!sanitized.includes('secretPass123'), 'Қателерді дезинфекциялау парольдерді толық жасырады');
  assert(sanitized.includes('admin:***@'), 'Қателерде қауіпсіз контекст сақталады');

  // Test 2: Statistical Calculations & CI
  console.log('\nTest Suite 2: Статистикалық есептеулер және 95% сенімділік аралығы');
  const sampleLatencies = [10, 12, 11, 13, 14, 12, 10, 15, 11, 12];
  const sampleStats = calculateLatencyStats(sampleLatencies, 0, 120);
  assert(sampleStats.count === 10, 'Таңдама көлемі дұрыс (10)');
  assert(sampleStats.mean_ms === 12, `Орташа мән дәл есептелді (${sampleStats.mean_ms} мс)`);
  assert(sampleStats.median_ms === 12, `Медиана (P50) дәл анықталды (${sampleStats.median_ms} мс)`);
  assert(sampleStats.min_ms === 10 && sampleStats.max_ms === 15, 'Min және Max мәндері дұрыс');
  assert(sampleStats.std_dev_ms > 0, `Стандартты ауытқу есептелді (σ = ${sampleStats.std_dev_ms} мс)`);
  assert(sampleStats.confidence_interval_95 > 0, `95% сенімділік аралығы есептелді (CI = ±${sampleStats.confidence_interval_95} мс)`);
  assert(sampleStats.p95_ms >= 14, `P95 перцентилі дұрыс (${sampleStats.p95_ms} мс)`);

  // Test 3: Mutex Concurrency Lock
  console.log('\nTest Suite 3: Параллельдік бұғаттау (Mutex Lock for Reproducible Benchmarks)');
  const lock1 = acquireBenchmarkLock();
  assert(lock1 === true, 'Бенчмарк құлпы алғаш рет сәтті алынды (Lock acquired)');
  const lock2 = acquireBenchmarkLock();
  assert(lock2 === false, 'Құлып алынып тұрғанда қатарлас эксперимент бұғатталады (Lock prevents race condition)');
  releaseBenchmarkLock();
  const lock3 = acquireBenchmarkLock();
  assert(lock3 === true, 'Құлып босатылғаннан кейін қайта сәтті алынды');
  releaseBenchmarkLock();

  // Test 4: Phase 5 - Index Experiment Repetitions Validation
  console.log('\nTest Suite 4: Индекстеу экспериментінің параметрлерін тексеру');
  try {
    await runControlledIndexExperiment(3);
    assert(false, 'Repetitions < 5 қабылданбауы тиіс еді');
  } catch (err: any) {
    assert(err.message.includes('Repetitions must be between 5 and 500'), 'Қайталау шектеуі (5-500) дұрыс тексерілді');
  }

  // Test 5: Honest connection check when no active connection or invalid URL
  console.log('\nTest Suite 5: Қосылым күйін шынайы тексеру (Honest Connection Reporting)');
  const connStatus = await checkDatabaseConnection();
  if (process.env.DATABASE_URL) {
    console.log(`  (DATABASE_URL анықталған: нақты қосылым тексерілуде)`);
    assert(typeof connStatus.connected === 'boolean', 'Қосылым күйі логикалық типпен қайтарылды');
  } else {
    assert(connStatus.connected === false, 'DATABASE_URL жоқ кезде connected=false қайтарады');
    assert(typeof connStatus.error === 'string', 'Офлайн кезде түсіндірме қате мәтіні беріледі');
  }

  // Test 6: Database status endpoint structure
  console.log('\nTest Suite 6: Деректер базасының күй құрылымы (Database Status Contract)');
  const status = await getDatabaseStatus();
  assert('connected' in status, 'Статус нысанында "connected" қасиеті бар');
  assert(typeof status.pool_max === 'number', 'Статуста pool_max параметрі бар');
  if (!status.connected) {
    assert(status.database_name === null, 'Офлайн кезде database_name = null');
    assert(status.version === null, 'Офлайн кезде version = null');
    assert(status.size_mb === null, 'Офлайн кезде size_mb = null');
    assert(status.active_connections === null, 'Офлайн кезде active_connections = null');
    assert(typeof status.error === 'string', 'Шынайы қате мәтіні ұсынылды');
  } else {
    assert(typeof status.database_name === 'string', 'Қосылған кезде нақты база аты қайтарылды');
    assert(typeof status.version === 'string', 'Қосылған кезде нақты PostgreSQL нұсқасы қайтарылды');
    assert(typeof status.size_mb === 'number', 'Қосылған кезде база көлемі (MB) қайтарылды');
    assert(typeof status.active_connections === 'number', 'Белсенді байланыстар саны қайтарылды');
  }

  // Test 7: Dataset Seed Strict Validation
  console.log('\nTest Suite 7: Деректер көлемін қатаң тексеру (10k, 100k, 1M)');
  const invalidSizes = [0, 500, 9999, 50000, -10000, 2000000, NaN];
  for (const badSize of invalidSizes) {
    try {
      await seedResearchDataset(badSize);
      assert(false, `Қате көлем қабылданбауы тиіс еді: ${badSize}`);
    } catch (err: any) {
      assert(
        err.message.includes('strictly 10000, 100000, or 1000000'),
        `Жарамсыз көлем дұрыс қабылданбады (${badSize})`
      );
    }
  }

  // Test 8: Live or Guarded Database Benchmarks
  if (!connStatus.connected) {
    console.log('\nTest Suite 8: Офлайн күйдегі қауіпсіздік шектеулері');
    try {
      await seedResearchDataset(10000);
      assert(false, 'База қосылмаған кезде мәлімет толтырылмауы керек');
    } catch (err: any) {
      assert(
        err.message.includes('PostgreSQL is not connected'),
        'Жалған деректер ойлап таппай, нақты қате лақтырады'
      );
    }

    try {
      await runControlledIndexExperiment(10, 'single_btree');
      assert(false, 'База қосылмаған кезде индекстеу эксперименті орындалмауы керек');
    } catch (err: any) {
      assert(
        err.message.includes('PostgreSQL database not connected'),
        'Индекстеу сынағы офлайн кезде жалған мәліметсіз нақты қате береді'
      );
    }
  } else {
    console.log('\nTest Suite 8: Нақты деректермен толтыру (10 000 жазба)');
    try {
      const seedRes = await seedResearchDataset(10000);
      assert(seedRes.status === 'ok', '10 000 жазба generate_series арқылы сәтті толтырылды');
      assert(seedRes.users_inserted === 10000, 'Пайдаланушылар саны дәл 10 000');
      assert(seedRes.orders_inserted === 10000, 'Тапсырыстар саны дәл 10 000');
      assert(seedRes.insertion_time_ms > 0, `Енгізу уақыты өлшенді (${seedRes.insertion_time_ms} мс)`);
    } catch (err: any) {
      assert(false, 'Деректер толтыру қатесі: ' + err.message);
    }

    console.log('\nTest Suite 9: Индекстерді басқару (Single B-tree және Composite B-tree)');
    try {
      // Single index
      const dropRes = await dropBenchmarkIndex(BENCHMARK_INDEX_NAME);
      assert(dropRes.success === true, 'B-tree индексі сәтті өшірілді');
      let exists = await checkBenchmarkIndexExists(BENCHMARK_INDEX_NAME);
      assert(exists === false, 'B-tree индексі жоқ екендігі расталды');

      const createRes = await createBenchmarkIndex();
      assert(createRes.success === true, 'B-tree индексі сәтті құрылды');
      exists = await checkBenchmarkIndexExists(BENCHMARK_INDEX_NAME);
      assert(exists === true, 'B-tree индексі бар екендігі расталды');

      // Composite index
      const dropComp = await dropBenchmarkIndex(BENCHMARK_COMPOSITE_INDEX_NAME);
      assert(dropComp.success === true, 'Композиттік индекс өшірілді');
      let compExists = await checkBenchmarkIndexExists(BENCHMARK_COMPOSITE_INDEX_NAME);
      assert(compExists === false, 'Композиттік индекс жоқ екендігі расталды');

      const createComp = await createCompositeBenchmarkIndex();
      assert(createComp.success === true, 'Композиттік индекс құрылды');
      compExists = await checkBenchmarkIndexExists(BENCHMARK_COMPOSITE_INDEX_NAME);
      assert(compExists === true, 'Композиттік индекс бар екендігі расталды');
    } catch (err: any) {
      assert(false, 'Индекс басқару қатесі: ' + err.message);
    }

    console.log('\nTest Suite 10: Барлық 6 SQL сұраныс сценарийі');
    const scenarios = [
      'by_id',
      'filter_email',
      'filter_status',
      'filter_sort_created',
      'count_aggregate',
      'join_orders',
    ] as const;

    for (const sc of scenarios) {
      try {
        const benchRes = await runRealSqlBenchmark(sc, 5);
        assert(benchRes.scenario === sc, `Сценарий ${sc} сәтті орындалды`);
        assert(benchRes.stats.count === 5, `${sc} үшін 5 қайталау өлшенді`);
        assert(benchRes.stats.mean_ms > 0, `Орташа кідіріс: ${benchRes.stats.mean_ms} мс`);
        assert(benchRes.stats.qps > 0, `Өткізу қабілеті: ${benchRes.stats.qps} QPS`);
        assert(typeof benchRes.explain_diagnostic.node_type === 'string', `EXPLAIN планы: ${benchRes.explain_diagnostic.node_type}`);
        assert(benchRes.persisted_id > 0, `Нәтиже сақталды (ID: #${benchRes.persisted_id})`);
      } catch (err: any) {
        assert(false, `Сценарий ${sc} қатесі: ` + err.message);
      }
    }

    console.log('\nTest Suite 11: Phase 5 - Жалғыз B-tree индекстеу эксперименті (email)');
    try {
      const expRes = await runControlledIndexExperiment(5, 'single_btree');
      assert(expRes.dataset_size === 10000, 'Сынақ 10 000 жазбада өтті');
      assert(expRes.configuration_a_unindexed.scan_type.includes('Seq Scan'), 'Индекссіз күй Seq Scan қолданады');
      assert(
        expRes.configuration_b_indexed.scan_type.includes('Index Scan') ||
        expRes.configuration_b_indexed.scan_type.includes('Bitmap'),
        `Индекстелген күй Index Scan қолданады (${expRes.configuration_b_indexed.scan_type})`
      );
      assert(expRes.comparison.speedup_multiplier > 0, `Жеделдеу есептелді: ${expRes.comparison.speedup_multiplier}x`);
      assert(expRes.configuration_a_unindexed.persisted_id > 0, 'Config A нәтижесі базада сақталды');
      assert(expRes.configuration_b_indexed.persisted_id > 0, 'Config B нәтижесі базада сақталды');
    } catch (err: any) {
      assert(false, 'B-tree эксперименті қатесі: ' + err.message);
    }

    console.log('\nTest Suite 12: Phase 5 - Композиттік B-tree эксперименті (status, created_at)');
    try {
      const expComp = await runControlledIndexExperiment(5, 'composite_btree');
      assert(expComp.dataset_size === 10000, 'Композиттік сынақ 10 000 жазбада өтті');
      assert(expComp.configuration_a_unindexed.has_sort === true, 'Индекссіз кезде explicit Sort түйіні анықталды');
      assert(expComp.comparison.speedup_multiplier > 0, `Композиттік жеделдеу: ${expComp.comparison.speedup_multiplier}x`);
    } catch (err: any) {
      assert(false, 'Композиттік индекс эксперименті қатесі: ' + err.message);
    }

    console.log('\nTest Suite 13: Сақталған нәтижелерді оқу');
    try {
      const persisted = await getPersistedBenchmarkResults(10);
      assert(Array.isArray(persisted) && persisted.length > 0, `${persisted.length} сақталған нәтиже алынды`);
      assert(persisted[0].id > 0, 'Жазбаның базалық ID-і дұрыс');
    } catch (err: any) {
      assert(false, 'Сақталған деректерді оқу қатесі: ' + err.message);
    }
  }

  console.log('\n-----------------------------------------------------------');
  console.log(`Тест қорытындысы: ${passed} өтті, ${failed} қате`);

  const pool = getPool();
  if (pool) {
    await pool.end();
  }
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
