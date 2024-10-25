const Apify = require('apify');
const GifEncoder = require('gif-encoder');
const faker = require('faker'); // Changed Faker to faker to match npm package
const autoconsent = require('@duckduckgo/autoconsent/dist/autoconsent.puppet.js');
const extraRules = require('@duckduckgo/autoconsent/rules/rules.json');
const { PuppeteerBlocker } = require('@ghostery/adblocker-puppeteer');
const fetch = require('cross-fetch');

const consentomatic = extraRules.consentomatic;
const rules = [
	...autoconsent.rules,
	...Object.keys(consentomatic).map((name) => new autoconsent.ConsentOMaticCMP(`com_${name}`, consentomatic[name])),
	...extraRules.autoconsent.map((spec) => autoconsent.createAutoCMP(spec)),
];

const { record, scrollDownProcess, getGifBuffer, compressGif, saveGif, slowDownAnimationsFn } = require('./helper');

const { log } = Apify.utils;

const wait = async (time) => {
	log.info(`Wait for ${time} ms`);
	return new Promise((resolve) => setTimeout(resolve, time));
};

Apify.main(async () => {
	const {
		url,
		viewportHeight = 768,
		viewportWidth = 1366,
		slowDownAnimations,
		waitToLoadPage,
		cookieWindowSelector,
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

	const proxyConfiguration = await Apify.createProxyConfiguration(proxyOptions);

	const browser = await Apify.launchPuppeteer({
		proxyUrl: proxyConfiguration?.newUrl(),
		launchOptions: { timeout: 90000 },
	});
	const page = await browser.newPage();

	const headers = {
		'Accept-Language': faker.random.locale(),
		'User-Agent': faker.internet.userAgent(),
		'X-Forwarded-For': faker.internet.ip(),
		'X-Real-IP': faker.internet.ip(),
		Referer: faker.internet.url(),
		Origin: faker.internet.url(),
		DNT: '1',
		Connection: 'keep-alive',
		'Cache-Control': 'no-cache',
		Pragma: 'no-cache',
	};

	log.info(`Setting extra headers: ${JSON.stringify(headers)}`);

	await page.setExtraHTTPHeaders(headers);

	await page.setDefaultNavigationTimeout(0);

	log.info('Setting up adblock');

	const blocker = await PuppeteerBlocker.fromLists(fetch, [
		'https://easylist.to/easylist/easylist.txt',
		'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
	]);
	await blocker.enableBlockingInPage(page);

	let elapsedTime = 0;

	log.info(`Setting page viewport to ${viewportWidth}x${viewportHeight}`);
	await page.setViewport({
		width: viewportWidth,
		height: viewportHeight,
	});

	if (slowDownAnimations) {
		slowDownAnimationsFn(page);
	}

	// check in case if input url doesn't have 'https://' part
	const validUrl = url.includes('http') ? url : `https://${url}`;

	page.once('load', async () => {
		try {
			const tab = autoconsent.attachToPage(page, validUrl, rules, 10);

			// Wait for tab to be ready and verify it exists
			if (!tab) {
				console.warn('CMP tab could not be created');
				return;
			}

			// Add timeout to prevent hanging
			const timeoutPromise = new Promise((_, reject) =>
				setTimeout(() => reject(new Error('CMP check timed out')), 15000)
			);

			// Wait for tab to be checked with timeout
			await Promise.race([tab.checked, timeoutPromise]);

			// Verify tab state before proceeding
			if (!tab.cmp) {
				console.info('No CMP detected on page');
				return;
			}

			// Attempt to handle consent
			const optInResult = await tab.doOptIn().catch((e) => {
				console.warn('Failed to opt in:', e);
				return null;
			});

			if (optInResult === null) {
				console.warn('Continuing without CMP handling');
			} else {
				console.info('Successfully handled CMP consent');
			}
		} catch (e) {
			console.warn('CMP handling failed, continuing anyway:', e.message);
		}
	});

	if (!validUrl.includes('youtube.com/watch')) {
		await Apify.utils.puppeteer.blockRequests(page, {
			urlPatterns: ['adsbygoogle.js'],
		});
	}

	log.info(`Opening page: ${validUrl}`);
	await page.goto(validUrl, { waitUntil: 'networkidle2', timeout: 0 });

	if (waitToLoadPage) {
		await wait(waitToLoadPage);
	}

	// remove cookie window if specified
	if (cookieWindowSelector) {
		try {
			await page.waitForSelector(cookieWindowSelector);

			log.info('Removing cookie pop-up window');
			await page.$eval(cookieWindowSelector, (el) => el.remove());
		} catch (err) {
			log.info('Selector for cookie pop-up window is likely incorrect');
		}
	}

	// set-up gif encoder
	const chunks = [];
	const gif = new GifEncoder(viewportWidth, viewportHeight);

	gif.setFrameRate(frameRate);
	gif.setRepeat(0); // loop indefinitely
	gif.on('data', (chunk) => chunks.push(chunk));
	gif.writeHeader();

	// add first frame multiple times so there is some delay before gif starts visually scrolling
	await record(page, gif, recordingTimeBeforeAction, frameRate);
	elapsedTime += recordingTimeBeforeAction;

	// start scrolling down and take screenshots
	if (scrollDown) {
		await scrollDownProcess({ page, gif, viewportHeight, scrollPercentage, elapsedTime, gifTime, frameRate });
	}

	// click element and record the action
	if (clickSelector) {
		try {
			await page.waitForSelector(clickSelector);
			log.info(`Clicking element with selector ${clickSelector}`);
			await page.click(clickSelector);
		} catch (err) {
			log.info('Click selector is likely incorrect');
		}

		await record(page, gif, recordingTimeAfterClick, frameRate);
	}

	browser.close();

	gif.finish();
	const gifBuffer = await getGifBuffer(gif, chunks);

	const urlObj = new URL(validUrl);
	const siteName = urlObj.hostname;
	const baseFileName = `${siteName}-scroll`;

	// Save to dataset so there is higher chance the user will find it
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
			const filenameLosless = `${baseFileName}_losless-comp`;
			await saveGif(filenameLosless, loslessBuffer);
			toPushDataset.gifUrlLosless = kvStore.getPublicUrl(filenameLosless);
		}
	} catch (error) {
		log.error(error);
	}

	await Apify.pushData(toPushDataset);

	log.info('Actor finished');
});
