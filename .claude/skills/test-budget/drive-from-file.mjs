// 參數太多時（Windows 命令列上限 32K）改從檔案讀，再照原樣交給 driver.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [driver, argsFile] = process.argv.slice(2);
process.argv = [process.argv[0], driver, ...JSON.parse(readFileSync(argsFile, 'utf8'))];
await import(pathToFileURL(driver).href);
