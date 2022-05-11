import * as dotenv from 'dotenv'
dotenv.config();

import { isMainThread, Worker, threadId, parentPort } from 'worker_threads'
import { randomString, sleep } from './utils'
import { PrismaClient } from '@prisma/client'
import { solveCaptcha } from './hcaptcha'

import MailcowClient from 'ts-mailcow-api'
import Imap from 'node-imap'
import axios, { AxiosProxyConfig } from 'axios'
import fs, { cp } from 'fs';
import utf8 from 'utf8'
import qp from 'quoted-printable'

import logger from './logger'

const mailcow = new MailcowClient(process.env.MAILCOW_HOST, process.env.MAILCOW_API_KEY);
const prisma = new PrismaClient();

if(isMainThread) {
    const proxies = fs.readFileSync("proxies.txt").toString().split("\n");
    const workers = [];

    for(let i = 0; i < proxies.length; i++) {
        workers.push(new Promise((resolve) => {
            const worker = new Worker('./dist/index.js', {
                env: {
                    ...process.env,
                    PROXY: proxies[i]
                }
            })
    
            worker.on('exit', (code) => {
                console.log(`Worker ${i} exited with code ${code}`)
            });
        }))
    }


    validateMails();
    setInterval(validateMails, 30 * 1000);

    Promise.all(workers);

    async function validateMails() {
        logger.info("Checking mails...")

        try {
            const mails = await getMails();
            logger.info("processing mails...");
        
            for await (const mail of mails) {
                if(mail.header.from.includes('Discord <noreply@discord.com>')) {
                    const user = mail.header.to[0];

                    let url = '';
                    let lines = mail.body.split('\r\n');

                    for(let i = lines.findIndex(l => l.startsWith("Verify Email: ")); i < lines.length; i++) {
                        if(lines[i].length > 1) {
                            url += lines[i];
                        } else {
                            break;
                        }
                    }

                    url = url.replace("Verify Email: ", "");
                    logger.info("Verifying email for user " + user + "...");

                    let res = await axios.get(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0'
                        }
                    });

                    const token = res.request.res.responseUrl.replace('https://discord.com/verify#token=', '');
                    const captchaKey = await solveCaptcha("f5561ba9-8f1e-40ca-9b5b-a0b3f719ef34", "discord.com");

                    try {
                        res = await axios.post('https://discord.com/api/v9/auth/verify', {
                            captcha_key: captchaKey,
                            token
                        });
                    } catch(err) {
                        logger.error("Failed to verify account :", err);
                        continue;
                    }

                    if(res.data.token) {
                        logger.success("Successfully verified account " + user);
                        await updateDatabase(user, res.data.userId);
                        await deleteAlias(user);
                    }
                }
            }      
        } catch(err) {
            return;
        }
    }

    function getMails() : Promise<Array<any>> {
        return new Promise((resolve, reject) => {
            const mails = [];

            const imap = new Imap({
                host: 'imap.redboxing.fr',
                port: 993,
                tls: true,
                user: process.env.MAILCOW_USER,
                password: process.env.MAILCOW_PASSWORD
            });
            
            imap.once('ready', () => {
                imap.openBox('INBOX', false, (err, box) => {
                    if(err) throw err;
                    imap.search(['UNSEEN'], (err, results) => {
                        if(err) throw err;
                        let f : Imap.ImapFetch;
    
                        try {
                             f = imap.fetch(results, { bodies: ['HEADER.FIELDS (FROM TO SUBJECT)', 'TEXT'], markSeen: true });
                        } catch(err) {
                            reject(err);
                            return;
                        }
    
                        f.on('message', msg => {
                            const data = {}
    
                            msg.on('body', (stream, info) => {                            
                                let buffer = '';
                                stream.on('data', chunk => {
                                    buffer += chunk.toString();
                                });
            
                                stream.on('end', () => {
                                    if(info.which !== 'TEXT') {
                                        data["header"] = Imap.parseHeader(buffer);
                                        
                                    } else {     
                                        data["body"] = Buffer.from(utf8.decode(qp.decode(buffer))).toString();
                                        mails.push(data);
                                    }
                                });

                                stream.on('error', reject);
                            });
                        });

                        f.on('error', reject)
            
                        f.once('end', () => {
                            imap.end();
                            resolve(mails);
                        })
                    });
                });
            });
            
            imap.once('error', reject);            
            imap.connect();
        })
    }
} else {    
    (async function main() {
        for(let i = 0; i < parseInt(process.env.ACCOUNT_TO_GENERATE); i++) { 
            const proxy = {
                host: process.env.PROXY.split(":")[0],
                port: parseInt(process.env.PROXY.split(':')[1]),
                auth: {
                    username: process.env.PROXY.split(':')[2],
                    password: process.env.PROXY.split(':')[3]
                }
            }

            await generateAccount(randomString(16), randomString(16), proxy);
        }
    })();

    async function generateAccount(username: string, password: string, proxy: AxiosProxyConfig) {
        logger.info(`[${threadId}] Generating account ${username}:${password}`);
        let retry = 0;
  
        let id = await createAlias(username);
        if(id == -1) {
            while(id == -1 && retry <= 5) {
                logger.error("Failed to create alias ! Retrying...");
                id = await createAlias(username);
                retry++;
            }

            retry = 0;
            if(id == -1) {
                logger.error("Failed to create alias ! Skipping...");
                return;
            }
        }

        const captchaKey = await solveCaptcha("4c672d35-0701-42b2-88c3-78380b0db560", "discord.com");
    
        let res = await axios.get('https://discord.com/api/v9/experiments', {
            proxy,
            validateStatus: s => true
        });

        if(!res.data.fingerprint) {
            while(!res.data.fingerprint && retry <= 5) {
                logger.error("Failed to get fingerprint ! Retrying...");
                if(res.data.message == "You are being rate limited.") {
                    sleep(parseFloat(res.data.retry_after) * 1000);
                } else {
                    await sleep(10000);
                }

                res = await axios.get('https://discord.com/api/v9/experiments', {
                    proxy,
                    validateStatus: s => true
                });

                retry++;
            }

            retry = 0;
            if(!res.data.fingerprint) {
                logger.error('Registration failed ! Skipping...');
                return; 
            }
        }
    
        let data = (await axios.post('https://discord.com/api/v9/auth/register', {
            captcha_key: captchaKey,
            consent: true,
            date_of_birth: (Math.floor(Math.random() * (2001 - 1990 + 1)) + 1990).toString() + "-" + (Math.floor(Math.random() * 12) + 1).toString() + "-" + (Math.floor(Math.random() * 28) + 1).toString(),
            email: username + "@" + process.env.MAILCOW_DOMAIN,
            fingerprint: res.data.fingerprint,
            gift_code_sku_id: null,
            invite: null,
            password,
            promotional_email_opt_in: false,
            username
        }, {
            headers: {
                'X-Fingerprint': res.data.fingerprint,
                'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJmciIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEwMC4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEwMC4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTAwLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6IiIsInJlZmVycmluZ19kb21haW4iOiIiLCJyZWZlcnJlcl9jdXJyZW50IjoiIiwicmVmZXJyaW5nX2RvbWFpbl9jdXJyZW50IjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6MTI3MTM1LCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsfQ=='
            },
            proxy,
            validateStatus: (status) => true
        })).data;

        if(!data.token) {
            while(!data.token && retry <= 5) {
                logger.error("Failed to register account ! Retrying...");
                if(res.data.message == "You are being rate limited.") {
                    sleep(parseFloat(res.data.retry_after) * 1000);
                } else {
                    await sleep(10000);
                }
                
                data = (await axios.post('https://discord.com/api/v9/auth/register', {
                    captcha_key: captchaKey,
                    consent: true,
                    date_of_birth: (Math.floor(Math.random() * (2001 - 1990 + 1)) + 1990).toString() + "-" + (Math.floor(Math.random() * 12) + 1).toString() + "-" + (Math.floor(Math.random() * 28) + 1).toString(),
                    email: username + "@" + process.env.MAILCOW_DOMAIN,
                    fingerprint: res.data.fingerprint,
                    gift_code_sku_id: null,
                    invite: null,
                    password,
                    promotional_email_opt_in: false,
                    username
                }, {
                    headers: {
                        'X-Fingerprint': res.data.fingerprint,
                        'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJmciIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEwMC4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEwMC4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTAwLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6IiIsInJlZmVycmluZ19kb21haW4iOiIiLCJyZWZlcnJlcl9jdXJyZW50IjoiIiwicmVmZXJyaW5nX2RvbWFpbl9jdXJyZW50IjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6MTI3MTM1LCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsfQ=='
                    },
                    proxy,
                    validateStatus: (status) => true
                })).data;

                retry++;
            }

            if(!data.token) {
                logger.error('Registration failed ! Skipping...');
                return;
            }
        }

        logger.success(`[${threadId}] Account created ! token: ${data.token}`);
        await saveToDatabase(username, username + "@" + process.env.MAILCOW_DOMAIN, password,  data.token);
    }
}

async function createAlias(name : string) : Promise<number> {
    const res = await mailcow.aliases.create({
        address: name + "@" + process.env.MAILCOW_DOMAIN,
        goto: process.env.MAILCOW_DESTINATION,
        sogo_visible: false,
        active: true
    });

    //@ts-expect-error
    if(res[0].type == "success") {
        return parseInt(res[0].msg[res[0].msg.length - 1]);
    } else {
        logger.error("Failed to create alias : " + JSON.stringify(res));
        return -1;
    }
}

async function deleteAlias(name: string) {
    const aliases = await mailcow.aliases.get("all");
    const alias = aliases.find(a => a.address == name + "@" + process.env.MAILCOW_DOMAIN);
    if(alias) {
        await mailcow.aliases.delete({
            items: [alias.id]
        });
    }
}

async function saveToDatabase(username: string, email: string, password: string, token: string) {
    await prisma.account.create({
        data: {
            userId: -1,
            username,
            email,
            password,
            token
        }
    });
}

async function updateDatabase(email: string, userId: number) {
    const account = await prisma.account.findFirst({
        where: {
            email,
        }
    });

    await prisma.account.update({
        where: {
            id: account.id
        },
        data: {
            userId
        }
    })
}