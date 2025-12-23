import * as cheerio from 'cheerio';
import XLSX from 'xlsx';
import fs from 'fs';
import puppeteer from 'puppeteer';

const USD_TO_RUB = 96;
const BASE_URL = 'https://naga.ac';
const MODELS_URL = `${BASE_URL}/models`;

// Задержка между запросами
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Функция для получения HTML страницы с рендерингом JavaScript
async function fetchPage(url, browser) {
    try {
        console.log(`Загрузка страницы: ${url}`);
        const page = await browser.newPage();
        
        // Устанавливаем user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Переходим на страницу и ждем загрузки
        await page.goto(url, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // Дополнительная задержка для загрузки динамического контента
        await delay(2000);
        
        // Получаем HTML
        const html = await page.content();
        await page.close();
        
        return html;
    } catch (error) {
        console.error(`Ошибка при загрузке ${url}:`, error.message);
        return null;
    }
}

// Парсинг главной страницы со списком моделей
async function parseModelsPage(html) {
    const $ = cheerio.load(html);
    const models = [];

    // Находим все карточки моделей - используем более общий селектор
    const cards = $('div').filter((i, el) => {
        const classes = $(el).attr('class') || '';
        return classes.includes('group') && classes.includes('relative') && classes.includes('rounded-lg');
    });

    console.log(`Найдено карточек: ${cards.length}`);

    cards.each((index, element) => {
        const $card = $(element);
        
        // Название модели - ищем заголовок h3 с ссылкой
        const $heading = $card.find('h3');
        const $link = $heading.find('a').first();
        const name = $link.text().trim();
        
        if (!name) return; // Пропускаем, если нет названия
        
        // Ссылка на модель
        const link = $link.attr('href');
        const fullLink = link ? `${BASE_URL}${link}` : '';
        
        // Количество токенов - ищем в правом верхнем углу карточки
        const tokens = $card.find('div.shrink-0 div.text-sm').text().trim();
        
        // Описание - параграф с классом text-sm и line-clamp
        const description = $card.find('p').filter((i, el) => {
            const classes = $(el).attr('class') || '';
            return classes.includes('text-sm') && classes.includes('line-clamp');
        }).text().trim();
        
        // Провайдер (by) - ссылка на startups
        const provider = $card.find('a[href^="/startups/"]').text().trim();
        
        // Цены - ищем в нижней части карточки
        const priceSpans = $card.find('div.flex.flex-wrap.gap-4 span');
        const priceTexts = [];
        priceSpans.each((i, el) => {
            const text = $(el).text().trim();
            if (text && !text.includes('by') && !text.includes('opacity')) {
                priceTexts.push(text);
            }
        });
        
        let inputPrice = 'Free';
        let outputPrice = 'Free';
        
        if (priceTexts.length > 0) {
            priceTexts.forEach(text => {
                if (text.toLowerCase().includes('free')) {
                    inputPrice = 'Free';
                    outputPrice = 'Free';
                } else if (text.includes('input')) {
                    inputPrice = text;
                } else if (text.includes('output')) {
                    outputPrice = text;
                } else if (text.includes('$') || text.includes('/')) {
                    // Если есть цена, но не указано input/output
                    if (inputPrice === 'Free') {
                        inputPrice = text;
                    } else {
                        outputPrice = text;
                    }
                }
            });
        }

        models.push({
            name,
            link: fullLink,
            tokens,
            description,
            provider,
            inputPrice,
            outputPrice
        });
    });

    return models;
}

// Парсинг страницы конкретной модели для получения детальных цен и возможностей
async function parseModelDetails(url, browser) {
    const html = await fetchPage(url, browser);
    if (!html) return null;

    const $ = cheerio.load(html);
    const details = {
        inputPrice: 'Free',
        outputPrice: 'Free',
        inputPriceNum: 0,
        outputPriceNum: 0,
        inputModalities: [],
        outputModalities: []
    };

    // Ищем блок с ценами - более гибкий поиск
    const pricingCards = $('div').filter((i, el) => {
        const classes = $(el).attr('class') || '';
        return classes.includes('border') && classes.includes('rounded-lg') && classes.includes('p-4');
    });
    
    pricingCards.each((index, element) => {
        const $card = $(element);
        const title = $card.find('h4').text().toLowerCase();
        const priceElement = $card.find('p').filter((i, el) => {
            const classes = $(el).attr('class') || '';
            return classes.includes('text-xl') || classes.includes('font-semibold');
        });
        const price = priceElement.text().trim();
        
        if (title.includes('input') && !title.includes('modalities')) {
            details.inputPrice = price;
            // Извлекаем числовое значение
            const match = price.match(/\$?([\d.]+)/);
            if (match) {
                details.inputPriceNum = parseFloat(match[1]);
            }
        } else if (title.includes('output') && !title.includes('modalities')) {
            details.outputPrice = price;
            const match = price.match(/\$?([\d.]+)/);
            if (match) {
                details.outputPriceNum = parseFloat(match[1]);
            }
        }
    });

    // Парсим Capabilities (Input/Output Modalities)
    const capabilitiesSection = $('h3').filter((i, el) => {
        return $(el).text().toLowerCase().includes('capabilities');
    }).parent();

    if (capabilitiesSection.length > 0) {
        // Input Modalities
        const inputModalitiesHeader = capabilitiesSection.find('h4').filter((i, el) => {
            return $(el).text().toLowerCase().includes('input modalities');
        });
        
        if (inputModalitiesHeader.length > 0) {
            const inputModalitiesContainer = inputModalitiesHeader.next();
            inputModalitiesContainer.find('span').filter((i, el) => {
                const classes = $(el).attr('class') || '';
                return classes.includes('text-ui-text-base') || classes.includes('font-medium');
            }).each((i, el) => {
                const modality = $(el).text().trim();
                if (modality && !details.inputModalities.includes(modality)) {
                    details.inputModalities.push(modality);
                }
            });
        }

        // Output Modalities
        const outputModalitiesHeader = capabilitiesSection.find('h4').filter((i, el) => {
            return $(el).text().toLowerCase().includes('output modalities');
        });
        
        if (outputModalitiesHeader.length > 0) {
            const outputModalitiesContainer = outputModalitiesHeader.next();
            outputModalitiesContainer.find('span').filter((i, el) => {
                const classes = $(el).attr('class') || '';
                return classes.includes('text-ui-text-base') || classes.includes('font-medium');
            }).each((i, el) => {
                const modality = $(el).text().trim();
                if (modality && !details.outputModalities.includes(modality)) {
                    details.outputModalities.push(modality);
                }
            });
        }
    }

    // Если не нашли в карточках, ищем текст "Free"
    if (details.inputPrice === 'Free' && details.outputPrice === 'Free') {
        const allText = $('body').text().toLowerCase();
        if (allText.includes('free')) {
            details.inputPrice = 'Free';
            details.outputPrice = 'Free';
        }
    }

    return details;
}

// Конвертация цены в рубли
function convertToRubles(priceStr) {
    if (priceStr === 'Free' || priceStr === 'N/A') {
        return 'Бесплатно';
    }
    
    const match = priceStr.match(/\$?([\d.]+)/);
    if (match) {
        const usdPrice = parseFloat(match[1]);
        const rubPrice = (usdPrice * USD_TO_RUB).toFixed(2);
        return `${rubPrice} ₽`;
    }
    
    return 'N/A';
}

// Основная функция парсинга
async function parseAllModels() {
    console.log('Начало парсинга моделей NagaAI...\n');
    console.log('Запуск браузера...');
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        // Получаем список моделей
        const mainPageHtml = await fetchPage(MODELS_URL, browser);
        if (!mainPageHtml) {
            console.error('Не удалось загрузить главную страницу');
            return [];
        }

        const models = await parseModelsPage(mainPageHtml);
        console.log(`Найдено моделей: ${models.length}\n`);

        if (models.length === 0) {
            console.log('⚠ Модели не найдены. Попробуем альтернативный метод...');
            // Сохраняем HTML для отладки
            fs.writeFileSync('debug_page.html', mainPageHtml, 'utf-8');
            console.log('HTML страницы сохранен в debug_page.html для анализа');
            return [];
        }

        // Получаем детальную информацию по каждой модели
        for (let i = 0; i < models.length; i++) {
            const model = models[i];
            console.log(`[${i + 1}/${models.length}] Обработка: ${model.name}`);
            
            if (model.link) {
                const details = await parseModelDetails(model.link, browser);
                if (details) {
                    model.inputPrice = details.inputPrice;
                    model.outputPrice = details.outputPrice;
                    model.inputPriceRub = convertToRubles(details.inputPrice);
                    model.outputPriceRub = convertToRubles(details.outputPrice);
                    model.inputModalities = details.inputModalities || [];
                    model.outputModalities = details.outputModalities || [];
                }
            }
            
            // Задержка между запросами
            if (i < models.length - 1) {
                await delay(1500);
            }
        }

        console.log('\nПарсинг завершен!\n');
        return models;
    } finally {
        await browser.close();
        console.log('Браузер закрыт');
    }
}

// Извлечение числового значения цены из строки
function extractPriceNumber(priceStr) {
    if (priceStr === 'Free' || priceStr === 'N/A' || !priceStr) {
        return 0;
    }
    const match = priceStr.match(/\$?([\d.]+)/);
    return match ? parseFloat(match[1]) : 0;
}

// Экспорт в Excel с формулами
function exportToExcel(models) {
    // Создаем данные для основной таблицы
    const data = models.map((model, index) => {
        const inputPriceNum = extractPriceNumber(model.inputPrice);
        const outputPriceNum = extractPriceNumber(model.outputPrice);
        
        return {
            'Название модели': model.name,
            'API ID': model.link ? model.link.split('/').pop().replace(/%3A/g, ':') : '',
            'Провайдер': model.provider,
            'Токены': model.tokens,
            'Описание': model.description,
            'Input Modalities': model.inputModalities ? model.inputModalities.join(', ') : '',
            'Output Modalities': model.outputModalities ? model.outputModalities.join(', ') : '',
            'Цена входных токенов (USD за 1M)': inputPriceNum,
            'Цена выходных токенов (USD за 1M)': outputPriceNum,
            'Ссылка': model.link
        };
    });

    // Создаем worksheet с пустым массивом
    const worksheet = {};
    
    // Добавляем шапку с информацией о курсе
    XLSX.utils.sheet_add_aoa(worksheet, [
        ['ПРАЙС-ЛИСТ МОДЕЛЕЙ NAGA AI', '', '', '', '', '', '', '', '', ''],
        ['Дата:', new Date().toLocaleString('ru-RU')],
        ['Курс (1 USD = RUB):', USD_TO_RUB],
        [''],
        ['Для пересчета по другому курсу измените значение в ячейке B3, все цены в рублях пересчитаются автоматически'],
        ['']
    ], { origin: 'A1' });
    
    // Строка с заголовками таблицы
    const dataStartRow = 7;
    const headersWithRub = [
        'Название модели',
        'API ID',
        'Провайдер',
        'Токены',
        'Описание',
        'Input Modalities',
        'Output Modalities',
        'Цена входных токенов (USD за 1M)',
        'Цена выходных токенов (USD за 1M)',
        'Цена входных токенов (RUB за 1M)',
        'Цена выходных токенов (RUB за 1M)',
        'Ссылка'
    ];
    
    XLSX.utils.sheet_add_aoa(worksheet, [headersWithRub], { origin: `A${dataStartRow}` });
    
    // Добавляем данные и формулы
    data.forEach((row, index) => {
        const rowNum = dataStartRow + 1 + index;
        const inputPrice = row['Цена входных токенов (USD за 1M)'];
        const outputPrice = row['Цена выходных токенов (USD за 1M)'];
        
        // Добавляем основные данные (A-I колонки)
        XLSX.utils.sheet_add_aoa(worksheet, [[
            row['Название модели'],
            row['API ID'],
            row['Провайдер'],
            row['Токены'],
            row['Описание'],
            row['Input Modalities'],
            row['Output Modalities'],
            inputPrice,
            outputPrice
        ]], { origin: `A${rowNum}` });
        
        // Добавляем формулы для конвертации в рубли (J-K колонки)
        if (inputPrice === 0) {
            worksheet[`J${rowNum}`] = { t: 's', v: 'Бесплатно' };
        } else {
            worksheet[`J${rowNum}`] = { t: 'n', f: `H${rowNum}*$B$3`, z: '0.00' };
        }
        
        if (outputPrice === 0) {
            worksheet[`K${rowNum}`] = { t: 's', v: 'Бесплатно' };
        } else {
            worksheet[`K${rowNum}`] = { t: 'n', f: `I${rowNum}*$B$3`, z: '0.00' };
        }
        
        // Добавляем ссылку (L колонка)
        worksheet[`L${rowNum}`] = { t: 's', v: row['Ссылка'] };
    });
    
    // Настройка ширины колонок
    worksheet['!cols'] = [
        { wch: 35 }, // Название модели
        { wch: 30 }, // API ID
        { wch: 15 }, // Провайдер
        { wch: 15 }, // Токены
        { wch: 70 }, // Описание
        { wch: 20 }, // Input Modalities
        { wch: 20 }, // Output Modalities
        { wch: 28 }, // Цена входных токенов (USD)
        { wch: 28 }, // Цена выходных токенов (USD)
        { wch: 28 }, // Цена входных токенов (RUB)
        { wch: 28 }, // Цена выходных токенов (RUB)
        { wch: 50 }  // Ссылка
    ];
    
    // Устанавливаем диапазон
    const range = XLSX.utils.decode_range(worksheet['!ref']);
    range.e.r = dataStartRow + data.length;
    range.e.c = 11; // L колонка (0-indexed)
    worksheet['!ref'] = XLSX.utils.encode_range(range);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Models');
    
    const filename = 'naga_models.xlsx';
    XLSX.writeFile(workbook, filename);
    console.log(`✓ Данные экспортированы в Excel: ${filename}`);
    console.log(`  📊 Курс: 1 USD = ${USD_TO_RUB} RUB`);
    console.log(`  💡 Для пересчета по другому курсу измените значение в ячейке B3`);
}

// Экспорт в TXT
function exportToTxt(models) {
    let content = '='.repeat(100) + '\n';
    content += 'NAGA AI MODELS - ПРАЙС-ЛИСТ\n';
    content += `Курс: 1 USD = ${USD_TO_RUB} RUB\n`;
    content += `Дата: ${new Date().toLocaleString('ru-RU')}\n`;
    content += '='.repeat(100) + '\n\n';

    models.forEach((model, index) => {
        const apiId = model.link ? model.link.split('/').pop().replace(/%3A/g, ':') : 'N/A';
        
        content += `${index + 1}. ${model.name}\n`;
        content += '-'.repeat(100) + '\n';
        content += `API ID: ${apiId}\n`;
        content += `Провайдер: ${model.provider}\n`;
        content += `Токены: ${model.tokens}\n`;
        content += `Описание: ${model.description}\n`;
        
        // Добавляем возможности
        if (model.inputModalities && model.inputModalities.length > 0) {
            content += `\nВходные форматы: ${model.inputModalities.join(', ')}\n`;
        }
        if (model.outputModalities && model.outputModalities.length > 0) {
            content += `Выходные форматы: ${model.outputModalities.join(', ')}\n`;
        }
        
        content += `\nЦены:\n`;
        content += `  • Входные токены (1M): ${model.inputPrice}`;
        if (model.inputPriceRub) {
            content += ` = ${model.inputPriceRub}`;
        }
        content += `\n`;
        content += `  • Выходные токены (1M): ${model.outputPrice}`;
        if (model.outputPriceRub) {
            content += ` = ${model.outputPriceRub}`;
        }
        content += `\n`;
        content += `\nСсылка: ${model.link}\n`;
        content += '\n' + '='.repeat(100) + '\n\n';
    });

    const filename = 'naga_models.txt';
    fs.writeFileSync(filename, content, 'utf-8');
    console.log(`✓ Данные экспортированы в TXT: ${filename}`);
}

// Запуск парсера
async function main() {
    try {
        const models = await parseAllModels();
        
        if (models.length > 0) {
            exportToExcel(models);
            exportToTxt(models);
            console.log(`\n✓ Успешно обработано моделей: ${models.length}`);
        } else {
            console.log('Модели не найдены');
        }
    } catch (error) {
        console.error('Ошибка:', error);
    }
}

main();

