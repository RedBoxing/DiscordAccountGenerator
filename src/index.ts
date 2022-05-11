import * as dotenv from 'dotenv'
dotenv.config();

import { isMainThread, Worker, threadId, parentPort } from 'worker_threads'
import { randomString, sleep } from './utils'
import { PrismaClient } from '@prisma/client'
import { solveCaptcha } from './hcaptcha'

import MailcowClient from 'ts-mailcow-api'
import Imap from 'imap'
import axios from 'axios'
import fs from 'fs';
import utf8 from 'utf8'
import qp from 'quoted-printable'

import logger from './logger'

const proxies = fs.readFileSync("proxies.txt").toString().split("\n");

const mailcow = new MailcowClient(process.env.MAILCOW_HOST, process.env.MAILCOW_API_KEY);
const prisma = new PrismaClient();

if(isMainThread) {
    const workers = [];

    for(let i = 0; i < process.env.WORKERS; i++) {
        workers.push(new Promise((resolve) => {
            const worker = new Worker('./dist/index.js', {
                env: process.env
            })
    
            worker.on('exit', (code) => {
                console.log(`Worker ${i} exited with code ${code}`)
            });
        }))
    }


    validateMails();
    setInterval(validateMails, 30 * 1000);

    Promise.all(workers);

    function validateMails() {
        logger.info("Checking mails...")

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
                        return;
                    }

                    f.on('message', msg => {
                        let discordMail = false;
                        let user = '';

                        msg.on('body', (stream, info) => {                            
                            let buffer = '';
                            stream.on('data', chunk => {
                                buffer += chunk.toString();
                            });
        
                            stream.on('end', () => {
                                if(info.which !== 'TEXT') {
                                    const headers = Imap.parseHeader(buffer);
                                    if(headers.from.includes('Discord <noreply@discord.com>')) {
                                        discordMail = true;
                                        user = headers.to[0];
                                    }
                                } else if(discordMail) {     
                                    // fix 3D character apearing in the body
                                    buffer = Buffer.from(utf8.decode(qp.decode(buffer))).toString();
                                        
                                    // get the url after "Verify Email: " in buffer and append next lines until the line is empty
                                    let url = '';
                                    let lines = buffer.split('\r\n');

                                    for(let i = lines.findIndex(l => l.startsWith("Verify Email: ")); i < lines.length; i++) {
                                        if(lines[i].length > 1) {
                                            url += lines[i];
                                        } else {
                                            break;
                                        }
                                    }
    
                                    url = url.replace("Verify Email: ", "");
                                    logger.info("Verifying email for user " + user + "...");

                                    axios.get(url, {
                                        headers: {
                                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0'
                                        }
                                    }).then(async res => {
                                        const token = res.request.res.responseUrl.replace('https://discord.com/verify#token=', '');
                                        const proxy = proxies[Math.floor(Math.random() * proxies.length)];
                                        const captchaKey = await solveCaptcha("f5561ba9-8f1e-40ca-9b5b-a0b3f719ef34", "discord.com", {
                                            host: proxy.split(":")[0],
                                            port: parseInt(proxy.split(":")[1]),
                                            auth: {
                                                username: proxy.split(":")[2],
                                                password: proxy.split(":")[3]
                                            }
                                        });
                                            
                                        axios.post('https://discord.com/api/v9/auth/verify', {
                                            captcha_key: captchaKey,
                                            token,
                                        }, {
                                            proxy: {
                                                host: proxy.split(":")[0],
                                                port: parseInt(proxy.split(":")[1]),
                                                auth: {
                                                    username: proxy.split(":")[2],
                                                    password: proxy.split(":")[3]
                                                }
                                            }
                                        }).then(res => {
                                            logger.success(`Successfully verified ${user}`);
                                            updateDatabase(user, res.data.userId);
                                        }).catch(err => {
                                            logger.error(`Failed to verify account ${user} :`, err);
                                        })

                                        deleteAlias(user);
                                    }).catch(err => {
                                        logger.error(`[${threadId}] Failed to verify account ${user} :`, err);
                                    });
                                }
                            });
                        });
                    });
        
                    f.once('error', err => {
                        console.log(err);
                    })
        
                    f.once('end', () => {
                        imap.end();
                    })
                });
            });
        });
        
        imap.once('error', err => {
            logger.error(err);
        })
        
        imap.connect();
    }
} else {    
    (async function main() {
        for(let i = 0; i < process.env.ACCOUNT_TO_GENERATE; i++) { 
            await generateAccount(randomString(16), randomString(16), proxies[Math.floor(Math.random() * proxies.length)]);
        }
    })();

    async function generateAccount(username: string, password: string, proxy: string) {
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
            proxy: {
                host: proxy.split(':')[0],
                port: parseInt(proxy.split(':')[1]),
                auth: {
                    username: proxy.split(':')[2],
                    password: proxy.split(':')[3]
                }
            },
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
                    proxy: {
                        host: proxy.split(':')[0],
                        port: parseInt(proxy.split(':')[1]),
                        auth: {
                            username: proxy.split(':')[2],
                            password: proxy.split(':')[3]
                        }
                    },
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
            proxy: {
                host: proxy.split(':')[0],
                port: parseInt(proxy.split(':')[1]),
                auth: {
                    username: proxy.split(':')[2],
                    password: proxy.split(':')[3]
                }
            },
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
                    proxy: {
                        host: proxy.split(':')[0],
                        port: parseInt(proxy.split(':')[1]),
                        auth: {
                            username: proxy.split(':')[2],
                            password: proxy.split(':')[3]
                        }
                    },
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