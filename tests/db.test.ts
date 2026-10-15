import {
  checkDatabaseConnection,
  getDatabaseStatus,
  seedResearchDataset,
  pgPoolMax,
  sanitizeDbError,
  getPool,
  checkBenchmarkIndexExists,
  createBenchmarkIndex,
  dropBenchmarkIndex,
  runRealSqlBenchmark,
  runControlledIndexExperiment,
  getPersistedBenchmarkResults,
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
  console.log('--- Running Phase 1 PostgreSQL Unit & Integration Tests ---');

  // Test 1: Configuration & Pool Settings
  console.log('\nTest Suite 1: Configuration & Security');
  assert(pgPoolMax === 10 || pgPoolMax > 0, `Pool maximum size is configured (value: ${pgPoolMax})`);
  const sampleSecretErr = new Error('Connection failed: postgresql://admin:secretPass123@ep-test.neon.tech/neondb');
  const sanitized = sanitizeDbError(sampleSecretErr);
  assert(!sanitized.includes('secretPass123'), 'Error sanitization redacts password from connection errors');
  assert(sanitized.includes('admin:***@'), 'Error sanitization leaves safe context in logs');

  // Test 2: Honest connection check when no active connection or invalid URL
  console.log('\nTest Suite 2: Honest Connection State Reporting');
  const connStatus = await checkDatabaseConnection();
  if (process.env.DATABASE_URL) {
    console.log(`  (DATABASE_URL is set: verifying live connection)`);
    assert(typeof connStatus.connected === 'boolean', 'Connection check returns boolean connected state');
  } else {
    assert(connStatus.connected === false, 'Reports connected=false when DATABASE_URL is not configured');
    assert(typeof connStatus.error === 'string', 'Provides explanatory error when offline');
  }

  // Test 3: Database status endpoint structure
  console.log('\nTest Suite 3: Database Status Payload Contract');
  const status = await getDatabaseStatus();
  assert('connected' in status, 'Status contains "connected" property');
  assert(typeof status.pool_max === 'number', 'Status contains pool_max setting');
  if (!status.connected) {
    assert(status.database_name === null, 'Returns null database_name when offline');
    assert(status.version === null, 'Returns null version when offline');
    assert(status.size_mb === null, 'Returns null size_mb when offline');
    assert(status.active_connections === null, 'Returns null active_connections when offline');
    assert(typeof status.error === 'string', 'Returns truthful error string');
  } else {
    assert(typeof status.database_name === 'string', 'Returns valid database_name string');
    assert(typeof status.version === 'string', 'Returns valid version string');
    assert(typeof status.size_mb === 'number', 'Returns valid size_mb number');
    assert(typeof status.active_connections === 'number', 'Returns active_connections count');
  }

  // Test 4: Dataset Seed Validation
  console.log('\nTest Suite 4: Dataset Seeding Strict Validation');
  const invalidSizes = [0, 500, 9999, 50000, -10000, 2000000, NaN];
  for (const badSize of invalidSizes) {
    try {
      await seedResearchDataset(badSize);
      assert(false, `Should reject invalid size ${badSize}`);
    } catch (err: any) {
      assert(
        err.message.includes('strictly 10000, 100000, or 1000000'),
        `Properly rejects invalid dataset size (${badSize})`
      );
    }
  }

  // Test 5: Live Seeding / Offline Guard
  console.log('\nTest Suite 5: Seeding Execution & Integrity');
  if (!connStatus.connected) {
    try {
      await seedResearchDataset(10000);
      assert(false, 'Should fail seeding when database is offline');
    } catch (err: any) {
      assert(
        err.message.includes('PostgreSQL is not connected'),
        'Throws honest exception when database is offline without fabricating rows'
      );
    }
  } else {
    console.log('  (Database is live: integration test seeding 10,000 rows into PostgreSQL)');
    try {
      const seedRes = await seedResearchDataset(10000);
      assert(seedRes.status === 'ok', 'Successfully seeded 10,000 rows in live database');
      assert(seedRes.users_inserted === 10000, 'Exact users row count verified');
      assert(seedRes.orders_inserted === 10000, 'Exact orders row count verified');
      assert(seedRes.insertion_time_ms > 0, 'Measured insertion time returned');
    } catch (err: any) {
      assert(false, 'Live seeding failed: ' + err.message);
    }

    // Test 6: Phase 2 - Benchmark Index Management
    console.log('\nTest Suite 6: Benchmark Index Lifecycle');
    try {
      const dropRes = await dropBenchmarkIndex();
      assert(dropRes.success === true, 'Successfully dropped benchmark index');
      let exists = await checkBenchmarkIndexExists();
      assert(exists === false, 'Index check confirms benchmark index does not exist');

      const createRes = await createBenchmarkIndex();
      assert(createRes.success === true, 'Successfully created benchmark index');
      exists = await checkBenchmarkIndexExists();
      assert(exists === true, 'Index check confirms benchmark index exists');
    } catch (err: any) {
      assert(false, 'Benchmark index management error: ' + err.message);
    }

    // Test 7: Phase 2 - Real Parameterized SQL Benchmarks
    console.log('\nTest Suite 7: Real SQL Benchmark Scenarios');
    const scenarios = ['filter_email', 'by_id', 'filter_sort_created', 'count_status'] as const;
    for (const sc of scenarios) {
      try {
        const benchRes = await runRealSqlBenchmark(sc, 5);
        assert(benchRes.scenario === sc, `Scenario ${sc} returned matching scenario name`);
        assert(benchRes.stats.count === 5, `Completed 5 repetitions for ${sc}`);
        assert(benchRes.stats.mean_ms > 0, `Measured positive mean latency (${benchRes.stats.mean_ms} ms) for ${sc}`);
        assert(benchRes.stats.qps > 0, `Measured positive QPS (${benchRes.stats.qps}) for ${sc}`);
        assert(typeof benchRes.explain_diagnostic.node_type === 'string', `EXPLAIN plan produced node type: ${benchRes.explain_diagnostic.node_type}`);
        assert(benchRes.persisted_id > 0, `Persisted run into benchmark_results (id: #${benchRes.persisted_id})`);
      } catch (err: any) {
        assert(false, `Scenario ${sc} benchmark failed: ` + err.message);
      }
    }

    // Test 8: Phase 2 - Controlled Index Experiment
    console.log('\nTest Suite 8: Controlled Index Optimization Experiment');
    try {
      const expRes = await runControlledIndexExperiment(5);
      assert(expRes.dataset_size === 10000, 'Controlled experiment ran against 10,000 seeded users');
      assert(expRes.configuration_a_unindexed.explain.node_type === 'Seq Scan', 'Unindexed configuration uses Sequential Scan');
      assert(
        expRes.configuration_b_indexed.explain.node_type === 'Index Scan' ||
        expRes.configuration_b_indexed.explain.node_type === 'Bitmap Index Scan',
        `Indexed configuration uses Index Scan (got ${expRes.configuration_b_indexed.explain.node_type})`
      );
      assert(expRes.comparison.speedup_multiplier > 0, `Speedup multiplier calculated: ${expRes.comparison.speedup_multiplier}x`);
      assert(expRes.configuration_a_unindexed.persisted_id > 0, 'Unindexed configuration persisted to database');
      assert(expRes.configuration_b_indexed.persisted_id > 0, 'Indexed configuration persisted to database');
    } catch (err: any) {
      assert(false, 'Controlled index experiment failed: ' + err.message);
    }

    // Test 9: Phase 2 - Persisted Results Query
    console.log('\nTest Suite 9: Persisted Benchmark Results in PostgreSQL');
    try {
      const persisted = await getPersistedBenchmarkResults(10);
      assert(Array.isArray(persisted) && persisted.length > 0, `Retrieved ${persisted.length} persisted benchmark records`);
      assert(persisted[0].id > 0, 'Persisted record has valid database id');
      assert(typeof persisted[0].average_latency_ms === 'number', 'Persisted record contains numeric average_latency_ms');
    } catch (err: any) {
      assert(false, 'Fetching persisted benchmark results failed: ' + err.message);
    }
  }

  console.log('\n-----------------------------------------------------------');
  console.log(`Results: ${passed} passed, ${failed} failed`);

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
