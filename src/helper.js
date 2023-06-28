const Apify = require('apify');

const { log } = Apify.utils;
const { PNG } = require('pngjs');
const imagemin = require('imagemin');
const imageminGiflossy = require('imagemin-giflossy');
const imageminGifsicle = require('imagemin-gifsicle');

const takeScreenshot = async (page) => {
    log.info('Taking screenshot');

    const screenshotBuffer = await page.screenshot({
        type: 'png',
    });

    return screenshotBuffer;
};

const parsePngBuffer = (buffer) => {
    const png = new PNG();
    return new Promise((resolve, reject) => {
        png.parse(buffer, (error, data) => {
            if (data) {
                resolve(data);
            } else {
                reject(error);
            }
        });
    });
};

const gifAddFrame = async (screenshotBuffer, gif) => {
    const png = await parsePngBuffer(screenshotBuffer);
    const pixels = png.data;

    log.debug('Adding frame to gif');
    gif.addFrame(pixels);
};

const record = async (page, gif, recordingTime, frameRate) => {
    const frames = (recordingTime / 1000) * frameRate;

    for (itt = 0; itt < frames; itt++) {
        const screenshotBuffer = await takeScreenshot(page);
        await gifAddFrame(screenshotBuffer, gif);
    }
};

const getScrollParameters = async ({ page, viewportHeight, scrolledTimes, frameRate}) => {
    // get page height to determine when we scrolled to the bottom
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight); // initially used body element height via .boundingbox() but this is not always equal to document height
    const scrollTop = await page.evaluate(() => document.documentElement.scrollTop);

    const initialPosition = viewportHeight + scrollTop;

    if (scrolledTimes % 4 == 0 || scrolledTimes % 5 == 0) {
        const scrollByAmount = 0;
    } else {
        const scrollByAmount = 100;
    }
    const scrolledTime = 1000 / frameRate;
    scrolledTimes += 1;

    return {
        pageHeight,
        initialPosition,
        scrollByAmount,
        scrolledTimes,
        scrolledTime
    };
};

const scrollDownProcess = async ({ page, gif, viewportHeight, elapsedTime, gifTime, frameRate}) => {
    let scrolledTimes = 0;
    const { pageHeight, initialPosition, scrollByAmount, scrolledTimes, scrolledTime } = await getScrollParameters({ page, viewportHeight, scrolledTimes, frameRate});
    let scrolledUntil = initialPosition;

    while (pageHeight > scrolledUntil && gifTime > elapsedTime) {
        const screenshotBuffer = await takeScreenshot(page);

        gifAddFrame(screenshotBuffer, gif);

        log.info(`Scrolling down by ${scrollByAmount} pixels`);
        await page.evaluate((scrollByAmount) => {
            window.scrollBy(0, scrollByAmount);
        }, scrollByAmount);

        scrolledUntil += scrollByAmount;
        elapsedTime += scrolledTime;

        const {pageHeight, initialPosition, scrollByAmount, scrolledTimes, scrolledTime} = await getScrollParameters({ page, viewportHeight, scrolledTimes, frameRate});
    }
};

const getGifBuffer = (gif, chunks) => {
    return new Promise((resolve, reject) => {
        gif.on('end', () => resolve(Buffer.concat(chunks)));
        gif.on('error', (error) => reject(error));
    });
};

const selectPlugin = (compressionType) => {
    switch (compressionType) {
        case 'ultralossy':
            return [
                imageminGiflossy({
                    lossy: 130,
                    optimizationLevel: 3,
                }),
            ];
        case 'lossy':
            return [
                imageminGiflossy({
                    lossy: 80,
                    optimizationLevel: 3,
                }),
            ];
        case 'losless':
            return [
                imageminGifsicle({
                    optimizationLevel: 3,
                }),
            ];
    }
};

const compressGif = async (gifBuffer, compressionType) => {
    log.info('Compressing gif');
    const compressedBuffer = await imagemin.buffer(gifBuffer, {
        plugins: selectPlugin(compressionType),
    });
    return compressedBuffer;
};

const saveGif = async (fileName, buffer) => {
    log.info(`Saving ${fileName} to key-value store`);
    const keyValueStore = await Apify.openKeyValueStore();
    const gifSaved = await keyValueStore.setValue(fileName, buffer, {
        contentType: 'image/gif',
    });
    return gifSaved;
};

const slowDownAnimationsFn = async (page) => {
    log.info('Slowing down animations');

    const session = await page.target().createCDPSession();

    return await Promise.all([
        session.send('Animation.enable'),
        session.send('Animation.setPlaybackRate', {
            playbackRate: 0.1,
        }),
    ]);
};

module.exports = {
    record,
    scrollDownProcess,
    getGifBuffer,
    compressGif,
    saveGif,
    slowDownAnimationsFn,
};
