const Apify = require('apify');
const { PNG } = require('pngjs');
const imagemin = require('imagemin');
const imageminGiflossy = require('imagemin-giflossy');
const imageminGifsicle = require('imagemin-gifsicle');

const { log } = Apify.utils;

/**
 * Takes a screenshot of the current page
 * @param {import('puppeteer').Page} page - Puppeteer page object
 * @returns {Promise<Buffer>} Screenshot buffer
 */
const takeScreenshot = async (page) => {
    log.info('Taking screenshot');
    return page.screenshot({ type: 'png' });
};

const parsePngBuffer = (buffer) => {
    const png = new PNG();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('PNG parsing timeout'));
        }, 30000);

        png.parse(buffer, (error, data) => {
            clearTimeout(timeout);
            if (error) {
                reject(error);
            } else if (data) {
                resolve(data);
            } else {
                reject(new Error('No data returned from PNG parser'));
            }
        });
    });
};

const gifAddFrame = async (screenshotBuffer, gif) => {
    try {
        const png = await parsePngBuffer(screenshotBuffer);
        log.debug('Adding frame to gif');
        gif.addFrame(png.data);
    } catch (error) {
        log.error('Error adding frame to gif:', error);
        throw error;
    }
};

const record = async (page, gif, recordingTime, frameRate) => {
    const frames = Math.floor((recordingTime / 1000) * frameRate);
    
    for (let i = 0; i < frames; i++) {
        try {
            const screenshotBuffer = await takeScreenshot(page);
            await gifAddFrame(screenshotBuffer, gif);
        } catch (error) {
            log.error(`Error recording frame ${i}:`, error);
            throw error;
        }
    }
};

const getScrollParameters = async ({ page, viewportHeight, scrollPercentage, frameRate }) => {
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const scrollTop = await page.evaluate(() => document.documentElement.scrollTop);

    return {
        pageHeight,
        initialPosition: viewportHeight + scrollTop,
        scrollByAmount: Math.round((viewportHeight * scrollPercentage) / 100),
        scrolledTime: 1000 / frameRate
    };
};

const scrollDownProcess = async ({ page, gif, viewportHeight, scrollPercentage, elapsedTime, gifTime, frameRate }) => {
    const { pageHeight, initialPosition, scrollByAmount, scrolledTime } = await getScrollParameters({
        page,
        viewportHeight,
        scrollPercentage,
        frameRate,
    });

    const config = {
        scrolledUntil: initialPosition,
        scrollTimes: 0,
        baseScrollAmount: scrollByAmount,
        maxScrolls: 10,
        waitScrolls: 7,
        minVariation: 27,
        maxVariation: 44,
    };

    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

    while (pageHeight > config.scrolledUntil && gifTime > elapsedTime) {
        const progress = config.scrolledUntil / pageHeight;
        const easedProgress = easeOutCubic(progress);
        
        const scrollAmount = config.scrollTimes > config.maxScrolls && 
            config.scrollTimes % (config.maxScrolls + config.waitScrolls) >= config.maxScrolls
            ? 0
            : config.minVariation + Math.floor(Math.random() * (config.maxVariation - config.minVariation));

        try {
            const screenshotBuffer = await takeScreenshot(page);
            await gifAddFrame(screenshotBuffer, gif);

            log.info(`Scrolling down by ${scrollAmount} pixels`);
            await page.evaluate((amount) => {
                window.scrollBy({
                    top: amount,
                    behavior: 'smooth'
                });
            }, scrollAmount);

            await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));

            config.scrolledUntil += scrollAmount;
            elapsedTime += scrolledTime;
            config.scrollTimes++;
        } catch (error) {
            log.error('Error during scroll process:', error);
            throw error;
        }
    }
};

const getGifBuffer = (gif, chunks) => {
    return new Promise((resolve, reject) => {
        gif.on('end', () => resolve(Buffer.concat(chunks)));
        gif.on('error', (error) => reject(error));
    });
};

const selectPlugin = (compressionType) => {
    const plugins = {
        ultralossy: [imageminGiflossy({ lossy: 130, optimizationLevel: 3 })],
        lossy: [imageminGiflossy({ lossy: 80, optimizationLevel: 3 })],
        losless: [imageminGifsicle({ optimizationLevel: 3 })]
    };
    return plugins[compressionType] || plugins.lossy;
};

const compressGif = async (gifBuffer, compressionType, maxRetries = 3) => {
    log.info(`Compressing gif with ${compressionType} compression`);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const compressedBuffer = await imagemin.buffer(gifBuffer, {
                plugins: selectPlugin(compressionType),
            });
            
            if (!compressedBuffer || compressedBuffer.length === 0) {
                throw new Error('Compression resulted in empty buffer');
            }
            
            return compressedBuffer;
        } catch (error) {
            log.warn(`Compression attempt ${attempt} failed:`, error);
            if (attempt === maxRetries) {
                throw new Error(`Gif compression failed after ${maxRetries} attempts`);
            }
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
    }
};

const saveGif = async (fileName, buffer) => {
    log.info(`Saving ${fileName} to key-value store`);
    const keyValueStore = await Apify.openKeyValueStore();
    return keyValueStore.setValue(fileName, buffer, {
        contentType: 'image/gif',
    });
};

module.exports = {
    record,
    scrollDownProcess,
    getGifBuffer,
    compressGif,
    saveGif,
};
