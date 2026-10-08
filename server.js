require('./runtime_version').checkRuntimeOrExit();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const { readFileSync } = require('node:fs');
const { renderHtml, publicConfigScript } = require('./public_config');
const { randomUUID } = require('crypto');
const { openReferenceDatabase } = require('./reference_database');
const { getPort } = require('./config');
const { getStore } = require('./state_store');
const { SearchJobs } = require('./search_jobs');
const { RemoteLogin } = require('./remote_login');
const { encryptionKey } = require('./encrypted_state');
const { createBrakeFluidLookup } = require('./brake_fluid');
const runMahle = require('./mahle_scraper');
const runMann = require('./mann_scraper'); 
const runPurolator = require('./purolator_scraper');
const runTora = require('./tora_scraper');
const runBosch = require('./bosch_scraper');
const runNgk = require('./ngk_scraper');
const runTorch = require('./torch_scraper');
const { createBendixRunner } = require('./bendix_scraper');
const { runZf } = require('./zf_scraper');
const { runZfOil } = require('./zf_oil_scraper');
const {
    clearSearchHistory,
    getSearchHistory,
    listSearchHistory,
    saveSearchHistory
} = require('./search_history');

const app = express();
const searchRunners = {
    mahle: runMahle,
    mann: runMann,
    purolator: runPurolator,
    tora: runTora,
    bosch: runBosch,
    ngk: runNgk,
    torch: runTorch,
    bendix_au: createBendixRunner('bendix_au'),
    bendix_my: createBendixRunner('bendix_my'),
    zf_trw_cn: runZf,
    zf_oil_cn: runZfOil
};
const MAX_SEARCH_BATCH_SIZE = 50;
const MAX_SPARK_BATCH_SIZE = 20;
const PORT = getPort();
const store = getStore();
encryptionKey(store);
const remoteLogin = new RemoteLogin(store);
const brandLabels = {
    mahle: 'MAHLE',
    mann: 'MANN-FILTER',
    purolator: 'Purolator',
    tora: 'Tora',
    bosch: 'Bosch',
    ngk: 'NGK',
    torch: 'TORCH',
    bendix_au: 'Bendix Australia',
    bendix_my: 'Bendix Malaysia',
    zf_trw_cn: 'ZF TRW China',
    zf_oil_cn: 'ZF Transmission Oil'
};

const sparkDatabasePath = process.env.SPARK_DATABASE_PATH || path.join(__dirname, 'data', 'sparkplug.db');
const sparkDatabase = openReferenceDatabase(sparkDatabasePath);

const sparkNgkVehicleStatement = sparkDatabase.prepare(`
    SELECT "力洋ID" AS liyangId,
           MAX(CAST(REPLACE(REPLACE(COALESCE("Latest Popul.", '0'), ',', ''), ' ', '') AS REAL)) AS latestPopulation,
           MAX("品牌") AS brand,
           MAX("车型") AS vehicleModel,
           MAX("发动机") AS engine,
           MAX("排量") AS displacement,
           MAX("进气形式") AS aspiration
      FROM ngk
     WHERE UPPER(TRIM("产品型号")) = ?
       AND TRIM(COALESCE("力洋ID", '')) <> ''
     GROUP BY "力洋ID"
     ORDER BY latestPopulation DESC, "力洋ID"
`);

function buildSparkCompetitorStatement(tableName, includeBoschFields) {
    const typeSelection = includeBoschFields
        ? `COALESCE(c."Type Formular", '') AS typeFormular,
           MAX(COALESCE(c."气缸数(个)", '')) AS cylinders,`
        : `'' AS typeFormular,
           '' AS cylinders,`;
    const typeGrouping = includeBoschFields ? ', COALESCE(c."Type Formular", \'\')' : '';
    const typeJoin = includeBoschFields ? 'AND rows.typeFormular = top.typeFormular' : '';

    return sparkDatabase.prepare(`
        WITH ids AS (
            SELECT DISTINCT "力洋ID"
              FROM ngk
             WHERE UPPER(TRIM("产品型号")) = ?
               AND TRIM(COALESCE("力洋ID", '')) <> ''
        ), rows AS (
            SELECT TRIM(c."产品型号") AS productNumber,
                   ${typeSelection}
                   c."力洋ID" AS liyangId,
                   MAX(CAST(REPLACE(REPLACE(COALESCE(c."Latest Popul.", '0'), ',', ''), ' ', '') AS REAL)) AS latestPopulation,
                   MAX(COALESCE(c."品牌", '')) AS brand,
                   MAX(COALESCE(c."车型", '')) AS vehicleModel,
                   MAX(COALESCE(c."发动机", '')) AS engine,
                   MAX(COALESCE(c."排量", '')) AS displacement,
                   MAX(COALESCE(c."进气形式", '')) AS aspiration
              FROM "${tableName}" c
              JOIN ids ON ids."力洋ID" = c."力洋ID"
             WHERE TRIM(COALESCE(c."产品型号", '')) <> ''
             GROUP BY TRIM(c."产品型号")${typeGrouping}, c."力洋ID"
        ), top AS (
            SELECT productNumber, typeFormular,
                   SUM(latestPopulation) AS totalPopulation,
                   COUNT(*) AS vehicleCount
              FROM rows
             GROUP BY productNumber, typeFormular
             ORDER BY totalPopulation DESC, productNumber
             LIMIT 3
        )
        SELECT top.productNumber, top.typeFormular, top.totalPopulation, top.vehicleCount,
               rows.liyangId, rows.latestPopulation, rows.brand, rows.vehicleModel,
               rows.engine, rows.displacement, rows.cylinders, rows.aspiration
          FROM top
          JOIN rows ON rows.productNumber = top.productNumber ${typeJoin}
         ORDER BY top.totalPopulation DESC, top.productNumber, top.typeFormular,
                  rows.latestPopulation DESC, rows.liyangId
    `);
}

const sparkBoschStatement = buildSparkCompetitorStatement('bosch', true);
const sparkTorchStatement = buildSparkCompetitorStatement('torch', false);

function groupSparkCompetitors(rows) {
    const groups = [];
    for (const row of rows) {
        let group = groups.at(-1);
        if (!group || group.productNumber !== row.productNumber || group.typeFormular !== row.typeFormular) {
            group = {
                rank: groups.length + 1,
                productNumber: row.productNumber,
                typeFormular: row.typeFormular || '',
                displayNumber: row.typeFormular ? `${row.productNumber} / ${row.typeFormular}` : row.productNumber,
                totalPopulation: Number(row.totalPopulation) || 0,
                vehicleCount: Number(row.vehicleCount) || 0,
                details: []
            };
            groups.push(group);
        }
        group.details.push({
            liyangId: row.liyangId,
            latestPopulation: Number(row.latestPopulation) || 0,
            brand: row.brand,
            vehicleModel: row.vehicleModel,
            engine: row.engine,
            displacement: row.displacement,
            cylinders: row.cylinders,
            aspiration: row.aspiration
        });
    }
    return groups;
}

function querySparkModel(inputModel) {
    const normalizedModel = inputModel.trim().toUpperCase();
    const ngkVehicles = sparkNgkVehicleStatement.all(normalizedModel).map((row) => ({
        ...row,
        latestPopulation: Number(String(row.latestPopulation || '0').replaceAll(',', '').replaceAll(' ', '')) || 0
    }));
    return {
        inputModel,
        normalizedModel,
        matched: ngkVehicles.length > 0,
        liyangIdCount: ngkVehicles.length,
        ngkVehicles,
        bosch: groupSparkCompetitors(sparkBoschStatement.all(normalizedModel)),
        torch: groupSparkCompetitors(sparkTorchStatement.all(normalizedModel))
    };
}

app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').status(200).json({ status: 'ok' }));
app.use(cors());
// Spark Plug vehicle-parc responses can contain tens of thousands of detail rows.
// Compress them before they cross ngrok; otherwise a multi-megabyte JSON response
// can take minutes and browsers surface the interrupted fetch as a TypeError.
app.use(compression({ threshold: 1024 }));
app.use('/api/brake-fluid/import', express.json({ limit: '64mb' }));
app.use(express.json());
app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html') || req.path.startsWith('/api/')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    next();
});
const indexHtml = renderHtml(readFileSync(path.join(__dirname, 'OE号智能匹配工具 (1).html'), 'utf8'));
app.get('/', (req, res) => res.type('html').send(indexHtml));
app.get('/runtime-config.js', (req, res) => res.set('Cache-Control', 'no-store').type('js').send(publicConfigScript()));
app.use('/remote-login.html', (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    next();
});
app.use(express.static(path.join(__dirname, 'public')));
remoteLogin.mount(app);

// Open lazily so an unavailable brake database does not interrupt other workspaces.
let brakeFluidLookup;
app.get('/api/brake-fluid/source', async (req, res) => {
    try {
        brakeFluidLookup ||= createBrakeFluidLookup(process.env.BRAKE_DATABASE_PATH || path.join(__dirname, 'data', 'brakeoil.db'));
        res.json(await brakeFluidLookup.source());
    } catch (error) {
        res.status(503).json({ error: '制动液数据库暂时不可用。' });
    }
});
app.post('/api/brake-fluid/import', async (req, res) => {
    try {
        brakeFluidLookup ||= createBrakeFluidLookup(process.env.BRAKE_DATABASE_PATH || path.join(__dirname, 'data', 'brakeoil.db'));
        res.json(await brakeFluidLookup.replaceMapping(req.body?.rows, req.body?.filename));
    } catch (error) {
        res.status(error.status || 503).json({ error: error.status === 400
            ? error.message : '导入失败，原 VIN 关联数据已保留，请稍后重试。' });
    }
});
app.post('/api/brake-fluid/lookup', async (req, res) => {
    try {
        brakeFluidLookup ||= createBrakeFluidLookup(process.env.BRAKE_DATABASE_PATH || path.join(__dirname, 'data', 'brakeoil.db'));
        res.json(await brakeFluidLookup.lookup(req.body?.vin));
    } catch (error) {
        res.status(error.status || 503).json({ error: error.status === 400
            ? error.message : '制动液数据库暂时不可用，请检查 brakeoil.db 后重试。' });
    }
});

app.post('/api/spark-plug/match', (req, res) => {
    const submittedModels = Array.isArray(req.body?.models) ? req.body.models : [];
    const models = [...new Map(submittedModels
        .map((value) => String(value).trim())
        .filter(Boolean)
        .map((value) => [value.toUpperCase(), value])).values()];

    if (models.length === 0) {
        return res.status(400).json({
            error: createSearchError('EMPTY_SPARK_BATCH', '请至少输入一个 NGK 产品型号。', 'Enter at least one NGK product model.')
        });
    }
    if (models.length > MAX_SPARK_BATCH_SIZE) {
        return res.status(400).json({
            error: createSearchError(
                'SPARK_BATCH_LIMIT_EXCEEDED',
                `每批最多支持 ${MAX_SPARK_BATCH_SIZE} 个 NGK 产品型号，当前提交了 ${models.length} 个。`,
                `Each batch supports up to ${MAX_SPARK_BATCH_SIZE} NGK product models; ${models.length} were submitted.`
            )
        });
    }

    try {
        const results = models.map(querySparkModel);
        return res.json({
            results,
            summary: {
                submitted: models.length,
                matched: results.filter((item) => item.matched).length,
                unmatched: results.filter((item) => !item.matched).length
            }
        });
    } catch (error) {
        console.error(`Spark Plug 查询失败: ${error.message}`);
        return res.status(500).json({
            error: createSearchError(
                'SPARK_DATABASE_ERROR',
                'Spark Plug 数据库查询失败，请检查 sparkplug.db 后重试。',
                'The Spark Plug database query failed. Check sparkplug.db and try again.'
            )
        });
    }
});

function getPublicJob(job, clientSessionId) {
    return {
        jobId: job.jobId,
        brand: job.brand,
        status: job.status,
        loginRequired: remoteLogin.publicPrompt(job.loginRequired, clientSessionId === job.clientSessionId),
        loginResolvedAt: job.loginResolvedAt || undefined,
        results: job.status === 'completed' ? job.results : undefined,
        error: ['failed', 'cancelled'].includes(job.status) ? job.error : undefined
    };
}

function getCancellationError(reason) {
    if (reason === 'replaced') {
        return createSearchError(
            'JOB_REPLACED',
            '该用户的上一次查询已关闭，新的查询任务已开始。',
            "This user's previous search was closed before the new search started."
        );
    }
    if (reason === 'heartbeat_timeout') {
        return createSearchError(
            'PAGE_CLOSED',
            '查询页面已关闭或失去连接，后台查询已自动停止。',
            'The search page was closed or disconnected, so the background search stopped automatically.'
        );
    }
    return createSearchError(
        'JOB_CANCELLED',
        '查询已取消，后台浏览器已经关闭。',
        'The search was cancelled and the background browser was closed.'
    );
}

function createSearchError(code, messageZh, messageEn) {
    return { code, messageZh, messageEn };
}

function classifySearchError(error, brand) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && error.code ? error.code : '';
    const label = brandLabels[brand] || brand;

    if (code === 'SITE_ACCESS_DENIED' || /ZF_ACCESS_BLOCKED/.test(message)) {
        return createSearchError('SOURCE_UNAVAILABLE', `${label} 拒绝访问或要求验证（${error.httpStatus || '访问限制'}），不是登录失败。请检查目标网站访问情况。`,
            `${label} denied access or requires verification. This is not a login failure. Check access to the source website.`);
    }
    if (code === 'SITE_RATE_LIMITED') {
        return createSearchError('SOURCE_UNAVAILABLE', `${label} 限制了请求频率（HTTP 429），请稍后重试。`, `${label} rate limited the request (HTTP 429). Retry later.`);
    }
    if (code === 'SITE_UNAVAILABLE' || code === 'SITE_HTTP_ERROR') {
        return createSearchError('SOURCE_UNAVAILABLE', `${label} 返回 HTTP ${error.httpStatus}，目标页面暂时不可用，请稍后重试。`,
            `${label} returned HTTP ${error.httpStatus}. The source page is unavailable. Retry later.`);
    }
    if (code === 'LOGIN_REQUIRED') {
        return createSearchError('LOGIN_REQUIRED', '目标网站需要有效登录状态，请更新该用户的登录会话后重试。',
            'This site requires a valid login session. Refresh the session and retry.');
    }
    if (['LOGIN_CANCELLED', 'LOGIN_TRANSFER_FAILED'].includes(code)) {
        return createSearchError(code, code === 'LOGIN_CANCELLED' ? '已取消站点授权。重新查询可再次打开登录入口。' : '授权后的登录状态未能恢复，请重新查询并授权。',
            'Site authorization was cancelled or could not be restored. Submit the query again to authorize.');
    }
    if (code === 'LOGIN_TIMEOUT' || /LOGIN_TIMEOUT|登录等待超时|未及时登录/.test(message)) {
        return createSearchError(
            'LOGIN_TIMEOUT',
            `${label} 登录等待超时：未在 5 分钟内完成登录。请更新登录会话后重新查询。`,
            `${label} login timed out because it was not completed within 5 minutes. Refresh the login session, then try again.`
        );
    }
    if (/Failed to launch|Could not find Chrome|executable.*not found|browser.*closed/i.test(message)) {
        return createSearchError(
            'BROWSER_UNAVAILABLE',
            '后台浏览器无法启动或已意外关闭。请检查容器浏览器及其依赖配置。',
            'The background browser could not start or closed unexpectedly. Check the container browser and its dependencies.'
        );
    }
    if (code === 'SITE_CONNECTION_ERROR' || /net::|ERR_|Navigation timeout|ECONN|ENOTFOUND|socket|network/i.test(message)) {
        return createSearchError(
            'NETWORK_ERROR',
            `${label} 网站连接失败。请检查网络、公司代理或目标网站状态后重试。`,
            `The connection to the ${label} website failed. Check the network, corporate proxy, or website status, then try again.`
        );
    }
    if (/Waiting for selector|无法加载.*搜索框|未找到.*搜索输入|搜索页面|search input/i.test(message)) {
        return createSearchError(
            'SOURCE_UNAVAILABLE',
            `${label} 搜索页面未能正常加载，页面结构可能已变化或网站暂时不可用。`,
            `The ${label} search page did not load correctly. Its page structure may have changed, or the website may be temporarily unavailable.`
        );
    }
    if (/Timeout|超时/i.test(message)) {
        return createSearchError(
            'QUERY_TIMEOUT',
            `${label} 未在规定时间内返回查询结果。请稍后重试。`,
            `${label} did not return search results within the allowed time. Please try again later.`
        );
    }
    return createSearchError(
        'SEARCH_ERROR',
        `${label} 查询失败：${message}`,
        `${label} search failed because of an unexpected error. Please review the server log and try again.`
    );
}

const jobs = new SearchJobs(store, {
    classifyError: classifySearchError, cancellationError: getCancellationError,
    saveHistory: saveSearchHistory, brandLabels, remoteLogin
});

app.post('/api/search/:brand', async (req, res, next) => {
    const { brand } = req.params;
    const runner = searchRunners[brand];
    if (!runner) return next();
    const isBrakePads = ['bendix_au', 'bendix_my', 'zf_trw_cn', 'zf_oil_cn'].includes(brand);

    const oeList = Array.isArray(req.body?.oeList)
        ? req.body.oeList.map((value) => String(value).trim()).filter(Boolean)
        : [];
    if (oeList.length === 0) {
        return res.status(400).json({
            error: createSearchError('EMPTY_BATCH', isBrakePads ? '请至少输入一个料号。' : '请至少输入一个 OE 号码。', isBrakePads ? 'Enter at least one part number.' : 'Enter at least one OE number.')
        });
    }
    if (oeList.length > MAX_SEARCH_BATCH_SIZE) {
        return res.status(400).json({
            error: createSearchError(
                'BATCH_LIMIT_EXCEEDED',
                `每个在线查询批次最多支持 ${MAX_SEARCH_BATCH_SIZE} 个${isBrakePads ? '料号' : ' OE 号'}，当前提交了 ${oeList.length} 个。`,
                `Each online-search batch supports a maximum of ${MAX_SEARCH_BATCH_SIZE} ${isBrakePads ? 'part numbers' : 'OE numbers'}; ${oeList.length} were submitted.`
            )
        });
    }

    const clientRequestId = typeof req.body?.clientRequestId === 'string'
        ? req.body.clientRequestId.trim().slice(0, 128)
        : '';
    const submittedSessionId = typeof req.body?.clientSessionId === 'string'
        ? req.body.clientSessionId.trim().slice(0, 128)
        : '';
    const clientSessionId = submittedSessionId || `anonymous-${randomUUID()}`;
    const job = await jobs.submit({ clientSessionId, clientRequestId, brand, oeList }, runner);
    res.status(202).json(getPublicJob(job, clientSessionId));
});

app.get('/api/search/jobs/client/:clientRequestId', async (req, res) => {
    const job = await jobs.getByRequest(req.params.clientRequestId, true);
    if (!job) return res.status(404).json({ error: createSearchError('JOB_NOT_FOUND', '未找到对应的查询任务。', 'The requested search job was not found.') });
    return res.json(getPublicJob(job, req.get('X-Client-Session-Id')));
});

app.get('/api/search/jobs/:jobId', async (req, res) => {
    const job = await jobs.get(req.params.jobId, true);
    if (!job) return res.status(404).json({ error: createSearchError('JOB_EXPIRED', '查询任务不存在或已过期。', 'The search job does not exist or has expired.') });
    return res.json(getPublicJob(job, req.get('X-Client-Session-Id')));
});

function getHistoryClientId(req) {
    return typeof req.query.clientSessionId === 'string'
        ? req.query.clientSessionId.trim().slice(0, 128)
        : '';
}

function sendMissingHistoryClientError(res) {
    return res.status(400).json({
        error: createSearchError(
            'CLIENT_ID_REQUIRED',
            '无法识别当前用户，不能读取查询历史。请刷新页面后重试。',
            'The current user could not be identified. Refresh the page before loading search history.'
        )
    });
}

app.get('/api/search/history', async (req, res) => {
    const clientSessionId = getHistoryClientId(req);
    if (!clientSessionId) return sendMissingHistoryClientError(res);
    return res.json({ records: await listSearchHistory(clientSessionId) });
});

app.get('/api/search/history/:historyId', async (req, res) => {
    const clientSessionId = getHistoryClientId(req);
    if (!clientSessionId) return sendMissingHistoryClientError(res);
    const record = await getSearchHistory(clientSessionId, req.params.historyId);
    if (!record) {
        return res.status(404).json({
            error: createSearchError('HISTORY_NOT_FOUND', '查询历史不存在或已被删除。', 'The search-history record does not exist or has been deleted.')
        });
    }
    return res.json({ record });
});

app.delete('/api/search/history', async (req, res) => {
    const clientSessionId = getHistoryClientId(req);
    if (!clientSessionId) return sendMissingHistoryClientError(res);
    await clearSearchHistory(clientSessionId);
    return res.status(204).end();
});

app.post('/api/search/jobs/:jobId/cancel', async (req, res) => {
    const job = await jobs.cancel(req.params.jobId);
    if (!job) return res.status(204).end();
    return res.status(202).json(getPublicJob(job));
});

app.post('/api/search/sessions/:clientSessionId/cancel', async (req, res) => {
    res.status(202).json({ cancelled: await jobs.cancelSession(req.params.clientSessionId) });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 503;
    res.status(status).json({ error: createSearchError('REQUEST_FAILED',
        status === 409 ? '查询正在处理中，请稍后重试。' : '请求暂时无法完成，请稍后重试。',
        status === 409 ? 'A search is still processing. Retry shortly.' : 'The request could not be completed. Retry shortly.') });
});

let server;
let shutdownStarted = false;
async function startServer() {
    await store.connect();
    await jobs.start();
    if (store.mode === 'memory') console.warn('Local memory storage: data will be lost on restart.');
    server = app.listen(PORT, '0.0.0.0', error => { if (!error) console.log(`服务已启动，监听端口 ${PORT}`); });
    server.on('error', error => { console.error(`Unable to listen on PORT: ${error.code || 'unknown'}`); void shutdownServer(1); });
}
async function shutdownServer(exitCode = 0) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    const deadline = setTimeout(() => process.exit(1), 20000);
    deadline.unref();
    const closed = new Promise(resolve => server ? server.close(resolve) : resolve());
    try {
        await jobs.close();
        await closed;
        sparkDatabase.close();
        brakeFluidLookup?.close();
        await store.close();
    } finally { process.exit(exitCode); }
}
process.on('SIGINT', () => { void shutdownServer(); });
process.on('SIGTERM', () => { void shutdownServer(); });
startServer().catch(() => { console.error('Startup failed. Check runtime, database and Redis configuration.'); void shutdownServer(1); });
