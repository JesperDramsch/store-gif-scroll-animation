const COMMON_AD_PATTERNS = [
    'googlesyndication.com',
    'doubleclick.net',
    'google-analytics.com',
    'facebook.com/plugins',
    'amazon-adsystem.com',
    'adnxs.com',
    'outbrain.com',
    'taboola.com'
];

const PRESERVE_PATTERNS = [
    // GitHub specific patterns
    'github.githubassets.com',
    'githubusercontent.com',
    'github.io',
    // Common CDNs that shouldn't be blocked
    'cloudflare.com',
    'jsdelivr.net',
    'unpkg.com',
    'cdnjs.cloudflare.com'
];

const setupContentBlocker = async (page) => {
    await page.setRequestInterception(true);

    page.on('request', async (request) => {
        const url = request.url();
        const resourceType = request.resourceType();

        // Always allow essential resource types
        if (['document', 'script', 'xhr', 'fetch', 'websocket'].includes(resourceType)) {
            // Check if it's from preserved domains
            if (PRESERVE_PATTERNS.some(pattern => url.includes(pattern))) {
                return request.continue();
            }
        }

        // Block known ad/tracking resources
        if (COMMON_AD_PATTERNS.some(pattern => url.includes(pattern))) {
            return request.abort();
        }

        // Block certain resource types that are commonly used for ads
        if (['image', 'media', 'font'].includes(resourceType)) {
            // Check if it's from preserved domains first
            if (PRESERVE_PATTERNS.some(pattern => url.includes(pattern))) {
                return request.continue();
            }
            
            // Block third-party resources
            const pageUrl = new URL(page.url());
            const requestUrl = new URL(url);
            if (pageUrl.hostname !== requestUrl.hostname) {
                return request.abort();
            }
        }

        // Continue with the request if none of the above conditions are met
        return request.continue();
    });
};

const setupConsentHandler = async (page, url) => {
    // Common consent banner selectors
    const CONSENT_SELECTORS = [
        '#consent-banner',
        '#cookie-banner',
        '.cookie-notice',
        '.consent-banner',
        '.cookie-banner',
        '[class*="cookie"]',
        '[class*="consent"]',
        '[id*="cookie"]',
        '[id*="consent"]',
        'div[aria-label*="cookie"]',
        'div[aria-label*="consent"]'
    ];

    // Site-specific handlers
    const SITE_SPECIFIC_HANDLERS = {
        'github.com': async () => {
            await page.evaluate(() => {
                localStorage.setItem('consent-banner', '{"version":1,"dismissedAt":1}');
                localStorage.setItem('cookie-preferences', '{"advertising":false,"functionality":true,"performance":false}');
            });
        },
        'default': async () => {
            await page.evaluate((selectors) => {
                selectors.forEach(selector => {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach(element => {
                        if (element && 
                            element.style && 
                            !element.closest('header') && 
                            !element.closest('nav')) {
                            element.remove();
                        }
                    });
                });
            }, CONSENT_SELECTORS);
        }
    };

    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {});

    const hostname = new URL(url).hostname;
    const handler = SITE_SPECIFIC_HANDLERS[hostname] || SITE_SPECIFIC_HANDLERS.default;
    await handler();

    await page.setCookie({
        name: 'cookieConsent',
        value: 'true',
        domain: hostname,
    });
};

const setupPage = async (page, url) => {
    await setupContentBlocker(page);
    
    await page.evaluateOnNewDocument(() => {
        window.cookieconsent_options = { dismiss: 'allow', allow: 'allow' };
        window.getCookie = (name) => name.includes('consent') ? 'true' : null;
        window.hasConsent = () => true;
    });

    await page.goto(url, { 
        waitUntil: 'networkidle2',
        timeout: 30000 
    });

    await setupConsentHandler(page, url);
};

module.exports = {
    setupPage,
    setupContentBlocker,
    setupConsentHandler
};
