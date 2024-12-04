const Apify = require('apify');
const GifEncoder = require('gif-encoder');
const { faker } = require('@faker-js/faker');
const { log } = Apify.utils;

const { record, scrollDownProcess, getGifBuffer, compressGif, saveGif } = require('./helper');
const { setupPage } = require('./contentBlocker');

const validateConfig = (config) => {
    const required = ['url', 'viewportHeight', 'viewportWidth', 'frameRate'];
    const missing = required.filter(key => !config[key]);
    
    if (missing.length > 0) {
        throw new Error(`Missing required configuration: ${missing.join(', ')}`);
    }
    
    if (config.viewportHeight < 100 || config.viewportHeight > 4000) {
        throw new Error('Invalid viewport height');
    }
    
    if (config.frameRate < 1 || config.frameRate > 60) {
        throw new Error('Invalid frame rate');
    }
};

const cleanup = async (browser, gif) => {
    try {
        if (browser) {
            await browser.close();
        }
        if (gif) {
            gif.finish();
        }
    } catch (error) {
        log.error('Cleanup error:', error);
    }
};

Apify.main(async () => {
    let browser;
    let gif;
    let chunks = [];
    
    try {
        const {
            url,
            viewportHeight = 768,
            viewportWidth = 1366,
            waitToLoadPage,
            frameRate,
            recordingTimeBeforeAction,
            scrollDown = true,
            scrollPercentage,
            clickSelector,
            recordingTimeAfterClick,
            lossyCompression,
            loslessCompression,
            gifTime,
            proxyOptions,
        } = await Apify.getInput();

        validateConfig({ url, viewportHeight, viewportWidth, frameRate });

        const proxyConfiguration = await Apify.createProxyConfiguration(proxyOptions);

        browser = await Apify.launchPuppeteer({
            proxyUrl: proxyConfiguration?.newUrl(),
            launchOptions: { 
                timeout: 90000,
                args: [
                    '--disable-gpu',
                    '--no-sandbox',
                    '--disable-setuid-sandbox'
                ]
            }
        });

        const page = await browser.newPage();

        const headers = {
            'Accept-Language': 'en-US,en;q=0.5',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
            'X-Forwarded-For': faker.internet.ip(),
            'X-Real-IP': faker.internet.ip(),
            Referer: faker.internet.url(),
            Origin: faker.internet.url(),
        };

        log.info(`Setting extra headers: ${JSON.stringify(headers)}`);
        await page.setExtraHTTPHeaders(headers);
        await page.setDefaultNavigationTimeout(0);
        
        let elapsedTime = 0;

        log.info(`Setting page viewport to ${viewportWidth}x${viewportHeight}`);
        await page.setViewport({
            width: viewportWidth,
            height: viewportHeight,
        });

        const validUrl = url.includes('http') ? url : `https://${url}`;
        await setupPage(page, validUrl);

        if (waitToLoadPage) {
            await new Promise(resolve => setTimeout(resolve, waitToLoadPage));
        }

        gif = new GifEncoder(viewportWidth, viewportHeight);
        gif.setFrameRate(frameRate);
        gif.setRepeat(0);
        gif.on('data', chunk => chunks.push(chunk));
        gif.writeHeader();

        await record(page, gif, recordingTimeBeforeAction, frameRate);
        elapsedTime += recordingTimeBeforeAction;

        if (scrollDown) {
            await scrollDownProcess({ 