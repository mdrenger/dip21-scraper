/* eslint-disable max-len */
/* eslint-disable no-throw-literal */

import DipBrowser from './DipBrowser';

const X2JS = require('x2js');
const Url = require('url');
const Querystring = require('querystring');
const _ = require('lodash');

const x2j = new X2JS();

process.setMaxListeners(Infinity);

class Scraper {
  options = {
    selectPeriods: false,
    selectOperationTypes: false,
    logStartSearchProgress: () => { },
    logUpdateSearchProgress: () => { },
    logStopSearchProgress: () => { },
    logStartDataProgress: () => { },
    logUpdateDataProgress: () => { },
    logStopDataProgress: () => { },
    logFinished: () => { },
    logError: () => { },
    outScraperData: () => { },
    doScrape: () => true,
    browserStackSize: 1,
    resultsPerPage: 200,
  };

  urls = {
    basisInfos: 'https://dipbt.bundestag.de/dip21.web/searchProcedures/simple_search_detail.do',
    processRunning:
      'https://dipbt.bundestag.de/dip21.web/searchProcedures/simple_search_detail_vp.do?vorgangId=',
    start: 'https://dipbt.bundestag.de/dip21.web/bt',
    search: 'https://dipbt.bundestag.de/dip21.web/searchProcedures.do;jsessionid=',
  };

  stack = [];
  availableFilters = {
    periods: [],
    operationTypes: [],
  };
  filters = [];
  procedures = [];
  status = {
    search: {
      instances: {
        sum: 0,
        completed: 0,
      },
      pages: {
        sum: 0,
        completed: 0,
      },
    },
  };
  browser;

  async scrape(options) {
    this.options = { ...this.options, ...options };
    const { browserStackSize } = this.options;

    let stackCreated = false;
    while (!stackCreated) {
      try {
        this.stack = await Promise.all(this.createBrowserStack({
          size: Math.max(browserStackSize, 1),
        }));
        stackCreated = true;
      } catch (error) {
        console.log('bundestag down (stack)');
        await this.timeout();
      }
    }
    let hasData = false;
    while (!hasData) {
      try {
        this.availableFilters = await this.takeSearchableValues({ browserObj: this.stack[0] });
        hasData = true;
      } catch (error) {
        console.log('bundestag down (search)');
        await this.timeout({ min: 10000, max: 10000 });
        await this.createNewBrowser({ browserObject: this.stack[0] })
          .then(async (newBrowser) => {
            this.stack[0] = newBrowser;
          })
          .catch(async (error2) => {
            this.options.logError({ error2 });
          });
      }
    }
    const filtersSelected = await this.configureFilter(this.availableFilters);

    this.options.logStartSearchProgress(this.status);
    await this.collectProcedures(filtersSelected);

    // Data
    this.completedLinks = 0;
    await this.options.logStartDataProgress({
      sum: this.procedures.length,
      retries: this.retries,
    });
    this.options.logStopSearchProgress();

    await Promise.all(this.stack.map(async (browser, browserIndex) => {
      await this.startAnalyse(browserIndex);
    })).then(async () => {
      this.options.logUpdateDataProgress({
        value: this.completedLinks,
        retries: this.retries,
        browsers: this.stack,
      });
      // Finalize
      this.options.logStopDataProgress();
      await this.finalize();
      this.options.logFinished();
    });
  }

  collectProcedures = async ({ periods, operationTypes }) => {
    periods.forEach((period) => {
      this.filters = [
        ...this.filters,
        ...operationTypes.map(operationType => ({ period, operationType, scraped: false })),
      ];
    });

    this.status.search.instances.sum = this.filters.length;

    await Promise.all(this.stack.map((browser, browserIndex) =>
      this.getProceduresFromSearch({ browser, browserIndex })));
    this.procedures = _.uniqBy(this.procedures, 'id');
  };

  getProceduresFromSearch = async ({ browser, browserIndex }) => {
    while (this.filters.findIndex(({ scraped }) => !scraped) !== -1) {
      let hasError = false;
      const filterIndex = this.filters.findIndex(({ scraped }) => !scraped);
      this.filters[filterIndex].scraped = true;
      try {
        const searchBody = await browser.browser.getBeratungsablaeufeSearchPage();
        const {
          formData,
          formMethod,
          formAction,
        } = await browser.browser.getBeratungsablaeufeSearchFormData({ body: searchBody });
        formData.wahlperiode = this.filters[filterIndex].period;
        formData.vorgangstyp = this.filters[filterIndex].operationType;
        formData.method = 'Suchen';
        formData.anzahlTreffer = this.options.resultsPerPage;

        await this.startSearch({
          browser,
          formData,
          formMethod,
          formAction,
        });
        this.status.search.instances.completed += 1;
        this.stack[browserIndex].errors = 0;
        this.options.logUpdateSearchProgress({ ...this.status, hasError });
      } catch (error) {
        hasError = true;
        this.options.logError({ error });
        this.filters[filterIndex].scraped = false;
        this.stack[browserIndex].errors += 1;
        this.options.logUpdateSearchProgress({ ...this.status, hasError });

        await this.timeout();
        if (this.stack[browserIndex].errors > 5) {
          throw {
            message: 'to many search errors',
            code: 1015,
          };
        }
      }
    }
  };

  async startAnalyse(browserIndex) {
    while (this.procedures.findIndex(({ scraped }) => !scraped) !== -1) {
      let hasError = false;
      if (!this.stack[browserIndex].browser) {
        hasError = true;
        this.options.logUpdateDataProgress({
          value: this.completedLinks,
          retries: this.retries,
          browsers: this.stack,
          hasError,
        });
        await this.timeout();
        await this.createNewBrowser({ browserObject: this.stack[browserIndex] })
          .then(async (newBrowser) => {
            this.stack[browserIndex] = newBrowser;
          })
          .catch(async (error) => {
            this.options.logError({ error });
          });
      } else {
        const linkIndex = this.procedures.findIndex(({ scraped }) => !scraped);

        this.stack[browserIndex].used = true;
        this.procedures[linkIndex].scraped = true;
        await this.saveJson({
          link: this.procedures[linkIndex].url,
          dipBrowser: this.stack[browserIndex].browser,
        })
          .then(async () => {
            this.completedLinks += 1;
            this.stack[browserIndex].used = false;
            this.stack[browserIndex].scraped += 1;
            this.stack[browserIndex].errors = 0;
            this.options.logUpdateDataProgress({
              value: this.completedLinks,
              retries: this.retries,
              browsers: this.stack,
              hasError,
            });
          })
          .catch(async (error) => {
            this.options.logError({ error });
            this.procedures[linkIndex].scraped = false;
            this.stack[browserIndex].used = false;
            this.stack[browserIndex].errors += 1;
            hasError = true;
            this.options.logUpdateDataProgress({
              value: this.completedLinks,
              retries: this.retries,
              browsers: this.stack,
              hasError,
            });

            await this.timeout();

            if (this.stack[browserIndex].errors >= 5) {
              await this.createNewBrowser({ browserObject: this.stack[browserIndex] })
                .then(async (newBrowser) => {
                  this.stack[browserIndex] = newBrowser;
                })
                .catch(async (error2) => {
                  this.options.logError({ error2 });
                });
            }
          });
      }
    }
  }

  finalize = async () => {
    this.stack = [];
    this.availableFilters = {
      periods: [],
      operationTypes: [],
    };
    this.filters = [];
    this.procedures = [];
    this.status = {
      search: {
        instances: {
          sum: 0,
          completed: 0,
        },
        pages: {
          sum: 0,
          completed: 0,
        },
      },
    };
  };

  createBrowserStack = ({ size }) => [...Array(size)].map(async () => this.createNewBrowser());

  createNewBrowser = async ({ browserObject } = {}) => {
    if (browserObject) {
      delete browserObject.browser; // eslint-disable-line
    }
    const browser = new DipBrowser();
    await browser.initialize();
    return {
      browser,
      used: false,
      scraped: 0,
      errors: 0,
    };
  };

  configureFilter = async ({ periods, operationTypes }) => {
    // Periods
    let selectedPeriods = [];
    if (_.isArray(this.options.selectPeriods)) {
      selectedPeriods = this.options.selectPeriods;
    } else if (_.isFunction(this.options.selectPeriods)) {
      selectedPeriods = await this.options.selectPeriods({ periods });
    } else {
      throw new Error(`Period must be type of "Array" or "function" witch return an array!\nYou give "${typeof this
        .options.selectPeriods}"`);
    }
    if (selectedPeriods.includes('Alle') || selectedPeriods.length === 0) {
      selectedPeriods = periods.filter(({ name }) => name !== 'Alle').map(({ name }) => name);
    }

    // OperationTypes
    let selectedOperationTypes = [];
    if (_.isArray(this.options.selectOperationTypes)) {
      selectedOperationTypes = this.options.selectOperationTypes;
    } else if (_.isFunction(this.options.selectOperationTypes)) {
      selectedOperationTypes = await this.options.selectOperationTypes({ operationTypes });
    } else {
      throw new Error(`Period must be type of "Array" or "function" witch return an array!\nYou give "${typeof this
        .options.selectOperationTypes}"`);
    }
    if (selectedOperationTypes.includes('Alle') || selectedOperationTypes.length === 0) {
      selectedOperationTypes = operationTypes
        .filter(({ name }) => name !== 'Alle')
        .map(({ number }) => number);
    }

    return {
      periods: selectedPeriods.map(p => periods.find(({ name }) => name === p).value),
      operationTypes: selectedOperationTypes.map(n => operationTypes.find(({ number }) => number === n).value),
    };
  };

  async selectPeriod({ browser, periodName }) {
    const period = this.availableFilters.periods.find(p => p.name === periodName);
    await Promise.all([
      browser.page.waitForNavigation({ waitUntil: ['domcontentloaded'] }),
      browser.page.select('select#wahlperiode', period.value),
    ]).catch((error) => {
      throw {
        error,
        function: 'selectPeriod',
        code: 1005,
      };
    });
  }

  async selectOperationTypes({ browser, operationTypeNumber }) {
    const operationType = this.availableFilters.operationTypes.find(o => o.number === operationTypeNumber);
    if (!operationType) {
      throw new Error(`OperationType "${operationTypeNumber}" not found`);
    }
    await browser.page.select('select#includeVorgangstyp', `${operationType.value}`);
  }

  takeSearchableValues = async ({ browserObj }) => {
    browserObj.used = true; // eslint-disable-line no-param-reassign
    const searchBody = await browserObj.browser.getBeratungsablaeufeSearchPage();
    const searchOptions = await browserObj.browser.getBeratungsablaeufeSearchOptions({
      body: searchBody,
    });
    if (searchOptions.vorgangstyp.length === 0) {
      throw new Error();
    }
    browserObj.used = false; // eslint-disable-line no-param-reassign
    return {
      periods: searchOptions.wahlperioden,
      operationTypes: searchOptions.vorgangstyp,
    };
  };

  startSearch = async ({
    browser, formData, formMethod, formAction,
  }) => {
    const { body: searchResultBody } = await browser.browser.getSearchResultPage({
      formMethod,
      formAction,
      formData,
    });

    const resultInfos = await browser.browser.getResultInfo({ body: searchResultBody });

    if (!resultInfos) {
      return;
    } else if (resultInfos === 'isEntry') {
      const procedureIdRegex = /\[ID:&nbsp;(.*?)\]/;
      const vorgangId = searchResultBody.match(procedureIdRegex)[1];
      this.procedures.push({
        id: vorgangId.split('-')[1],
        url: `/dip21.web/searchProcedures/simple_search_list.do?selId=${
          vorgangId.split('-')[1]
        }&method=select&offset=0&anzahl=200&sort=3&direction=desc`,
        scraped: false,
      });
      return;
    }

    this.status.search.pages.sum += resultInfos.pageSum;
    let pagesCompleted = 0;
    let searchResultBodyToAnalyse = searchResultBody;
    for (let i = resultInfos.pageCurrent; i <= resultInfos.pageSum; i += 1) {
      try {
        if (i !== 1) {
          const {
            formMethod: newFormMethod,
            formAction: newFormAction,
            formData: newFormData,
          } = await browser.browser.getBeratungsablaeufeSearchFormData({ body: searchResultBodyToAnalyse });
          newFormData.method = '>'; // Next page can only be reached through this
          newFormData.offset = (i - 1) * this.options.resultsPerPage;
          const { body: tmpBody } = await browser.browser.getSearchResultPage({
            formMethod: newFormMethod,
            formAction: `http://dipbt.bundestag.de${newFormAction}`,
            formData: newFormData,
          });
          searchResultBodyToAnalyse = tmpBody;
        }

        let pageLinks = browser.browser.getEntries({ body: searchResultBodyToAnalyse });
        pageLinks = pageLinks.filter(link => this.options.doScrape({ data: link }));
        this.procedures.push(...pageLinks);
        this.status.search.pages.completed += 1;
        pagesCompleted += 1;
      } catch (error) {
        i = 1;
        this.status.search.pages.sum -= resultInfos.pageSum;
        this.status.search.pages.completed -= pagesCompleted;
        throw {
          error,
          function: 'startSearch',
          type: 'timeout',
          code: 1008,
        };
      }
      this.options.logUpdateSearchProgress(this.status);
    }
  };

  async saveJson({ link, dipBrowser }) {
    const procedureIdRegex = /\[ID:&nbsp;(.*?)\]/;
    const { body: entryBody } = await dipBrowser.request({
      uri: link,
    });

    let procedureId;
    try {
      procedureId = entryBody.match(procedureIdRegex)[1]; // eslint-disable-line
    } catch (error) {
      throw {
        error,
        code: 1012,
      };
    }
    const urlObj = Url.parse(link);
    const queryObj = Querystring.parse(urlObj.query);
    const vorgangId = queryObj.selId;
    if (procedureId.split('-')[1] !== vorgangId) {
      const error = new Error(`Procedure ID missmatch URL: "${vorgangId}" to HTML: "${procedureId.split('-')[1]}"`);
      throw {
        error,
        code: 1013,
      };
    }

    const dataProcedure = await this.getProcedureData({ html: entryBody });

    const { body: entryRunningBody } = await dipBrowser.request({
      uri: `${this.urls.processRunning}${vorgangId}`,
    });

    const dataProcedureRunning = await Scraper.getProcedureRunningData({
      html: entryRunningBody,
    });

    const procedureData = {
      vorgangId,
      ...dataProcedure,
      ...dataProcedureRunning,
    };
    this.options.outScraperData({ procedureId, procedureData });
  }

  getProcedureData = async ({ html }) => {
    const xmlRegex = /<VORGANG>(.|[\r\n])*<\/VORGANG>/;
    const xmlString = html.match(xmlRegex)[0].replace('<- VORGANGSABLAUF ->', '');
    return x2j.xml2js(xmlString);
  };

  static async getProcedureRunningData({ html }) {
    const xmlRegex = /<VORGANGSABLAUF>(.|[\r\n])*<\/VORGANGSABLAUF>/;
    const xmlString = html.match(xmlRegex)[0];
    return x2j.xml2js(xmlString);
  }

  timeout = async ({ min, max } = { min: 1000, max: 5000 }) =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, _.random(min, max));
    });
}

module.exports = Scraper;
