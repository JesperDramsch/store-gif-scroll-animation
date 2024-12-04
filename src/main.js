const Apify = require('apify');
const GifEncoder = require('gif-encoder');
const { faker } = require('@faker-js/faker');
const { log } = Apify.utils;

const { record, scrollDownProcess, getGifBuffer, compressGif, saveGif } = require('./helper');
const { setupPage } = require('./contentBlocker.js');

const validateConfig = (config) => {
	const required = ['url', 'viewportHeight', 'viewportWidth', 'frameRate'];
	const missing = required.filter((key) => !config[key]);

	if (missing.length > 0) {
		throw new Error(`Missing required configuration: ${missing.join(', ')}`);
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
	let page;
	let elapsedTime = 0; // Initialize elapsedTime here

	try {
		const input = await Apify.getInput();
		const {
			url,
			viewportHeight = 768,
			viewportWidth = 1366,
			waitToLoadPage = 5000,
			frameRate = 10,
			recordingTimeBeforeAction = 1000,
			scrollDown = true,
			scrollPercentage = 50,
			clickSelector,
			recordingTimeAfterClick,
			lossyCompression,
			loslessCompression,
			gifTime = 30000,
			proxyOptions,
		} = input;

		validateConfig({ url, viewportHeight, viewportWidth, frameRate });

		const proxyConfiguration = await Apify.createProxyConfiguration(proxyOptions);

		browser = await Apify.launchPuppeteer({
			proxyUrl: proxyConfiguration?.newUrl(),
			launchOptions: {
				timeout: 90000,
				args: [
					'--disable-gpu',
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-web-security',
					'--disable-features=IsolateOrigins,site-per-process',
					'--disable-site-isolation-trials',
					'--ignore-certificate-errors',
					'--no-zygote',
					'--single-process',
					'--no-first-run',
				],
			},
		});

		page = await browser.newPage();

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

		log.info(`Setting page viewport to ${viewportWidth}x${viewportHeight}`);
		await page.setViewport({
			width: viewportWidth,
			height: viewportHeight,
		});

		const validUrl = url.includes('http') ? url : `https://${url}`;
		log.info(`Navigating to ${validUrl}`);

		log.info(`Setting up content blocking.`);
		let setupSuccess = false;
		for (let attempt = 1; attempt <= 3 && !setupSuccess; attempt++) {
			try {
				await setupPage(page, validUrl);
				setupSuccess = true;
			} catch (error) {
				log.warning(`Page setup attempt ${attempt} failed:`, error.message);
				if (attempt === 3) {
					throw new Error(`Failed to set up page after ${attempt} attempts`);
				}
				await new Promise((resolve) => setTimeout(resolve, 5000));
			}
		}

		// Wait for network to be idle
		log.info(`Waiting for network to idle.`);
		try {
			await page.waitForNetworkIdle({ timeout: 30000 }).catch(() => {
				log.warning('Network did not reach idle state');
			});
		} catch (error) {
			log.warning('Network idle timeout:', error);
		}

		// Additional wait time if specified
		if (waitToLoadPage) {
			await new Promise((resolve) => setTimeout(resolve, waitToLoadPage));
		}

		// Initialize GIF encoder
		gif = new GifEncoder(viewportWidth, viewportHeight);
		gif.setFrameRate(frameRate);
		gif.setRepeat(0);
		gif.on('data', (chunk) => chunks.push(chunk));
		gif.writeHeader();

		// Initial recording
		log.info('Starting initial recording');
		await record(page, gif, recordingTimeBeforeAction, frameRate);
		elapsedTime += recordingTimeBeforeAction;

		// Scroll if enabled
		if (scrollDown) {
			log.info('Starting scroll process');
			await scrollDownProcess({
				page,
				gif,
				viewportHeight,
				scrollPercentage,
				elapsedTime,
				gifTime,
				frameRate,
			});
		}

		// Handle click action if specified
		if (clickSelector) {
			try {
				await page.waitForSelector(clickSelector, { timeout: 5000 });
				log.info(`Clicking element with selector ${clickSelector}`);
				await page.click(clickSelector);

				if (recordingTimeAfterClick) {
					await record(page, gif, recordingTimeAfterClick, frameRate);
					elapsedTime += recordingTimeAfterClick;
				}
			} catch (error) {
				log.error('Error during click operation:', error);
			}
		}

		// Finalize and save GIF
		log.info('Finalizing GIF');
		await browser.close();
		gif.finish();

		const gifBuffer = await getGifBuffer(gif, chunks);
		const urlObj = new URL(validUrl);
		const siteName = urlObj.hostname;
		const baseFileName = `${siteName}-scroll`;

		const toPushDataset = {
			gifUrlOriginal: undefined,
			gifUrlLossy: undefined,
			gifUrlLosless: undefined,
		};

		const kvStore = await Apify.openKeyValueStore();

		try {
			const filenameOrig = `${baseFileName}_original.gif`;
			await saveGif(filenameOrig, gifBuffer);
			toPushDataset.gifUrlOriginal = kvStore.getPublicUrl(filenameOrig);

			if (lossyCompression) {
				const lossyBuffer = await compressGif(gifBuffer, 'lossy');
				log.info('Lossy compression finished');
				const filenameLossy = `${baseFileName}_lossy-comp.gif`;
				await saveGif(filenameLossy, lossyBuffer);
				toPushDataset.gifUrlLossy = kvStore.getPublicUrl(filenameLossy);
			}

			if (loslessCompression) {
				const loslessBuffer = await compressGif(gifBuffer, 'losless');
				log.info('Losless compression finished');
				const filenameLosless = `${baseFileName}_losless-comp.gif`;
				await saveGif(filenameLosless, loslessBuffer);
				toPushDataset.gifUrlLosless = kvStore.getPublicUrl(filenameLosless);
			}
		} catch (error) {
			log.error('Error during gif processing:', error);
			throw error;
		}

		await Apify.pushData(toPushDataset);
		log.info('Actor finished successfully');
	} catch (error) {
		log.error('Actor failed:', error);
		throw error;
	} finally {
		await cleanup(browser, gif);
	}
});
