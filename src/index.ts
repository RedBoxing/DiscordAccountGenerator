import * as dotenv from 'dotenv'
dotenv.config();

import { isMainThread, Worker, threadId } from 'worker_threads'
import { HttpsProxyAgent } from 'https-proxy-agent';
import { solveCaptcha } from './hcaptcha'
import { randomString } from './utils'

import mariadb from 'mariadb'
import Imap from 'imap'
import axios from 'axios'
import fs from 'fs';
import utf8 from 'utf8'
import qp from 'quoted-printable'

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
    setInterval(async () => {
        await validateMails();
    }, 30 * 1000)

    Promise.all(workers);

    function validateMails() : Promise<any> {
        return new Promise((resolve, reject) => {
            console.log("Checking mails...");

            const imap = new Imap({
                host: 'imap.redboxing.fr',
                port: 993,
                tls: true,
                user: process.env.MAILCOW_USER,
                password: process.env.MAILCOW_PASSWORD
            });
        
            imap.once('ready', () => {
                imap.openBox('INBOX', true, (err, box) => {
                    if(err) throw err;
                    imap.search(['UNSEEN'], (err, results) => {
                        if(err) throw err;
                        
                        let f : Imap.ImapFetch;

                        try {
                            f = imap.fetch(results, { bodies: ['HEADER.FIELDS (FROM TO SUBJECT)', 'TEXT'], markSeen: true });
                        } catch {
                            resolve(null);
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

                                        fs.writeFile('./test.html', buffer, () => {})

                                        for(let i = lines.findIndex(l => l.startsWith("Verify Email: ")); i < lines.length; i++) {
                                            if(lines[i].length > 1) {
                                                url += lines[i];
                                            } else {
                                                break;
                                            }
                                        }
    
                                        url = url.replace("Verify Email: ", "");

                                        axios.get(url, {
                                            headers: {
                                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0'
                                            }
                                        }).then(res => {
                                            console.log(`[${threadId}] Account ${user} verified !`);
                                           /* msg.once('attributes', attrs => {
                                                imap.addFlags(attrs.uid, "Seen", err => {
                                                    if(err) throw err;
                                                });
                                            });*/
                                            resolve(null);
                                        }).catch(err => {
                                            console.error(`[${threadId}] Failed to verify account ${user} ! `, err);
                                            reject(err);
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
                console.log(err);
            })
        
            imap.connect();
        });
    }
} else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.log("Initializing worker #" + threadId)

    const pool = mariadb.createPool({
        host: process.env.MYSQL_HOST,
        port: process.env.MYSQL_PORT,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE
    });
    
    const proxies = fs.readFileSync("proxies.txt").toString().split("\n");
    
    (async function main() {
        for(let i = 0; i < process.env.ACCOUNT_TO_GENERATE; i++) {
            const proxy = proxies[Math.floor(Math.random() * proxies.length)];
            await generateAccount(randomString(10), randomString(16), new HttpsProxyAgent({
                host: proxy.split(":")[0],
                port: proxy.split(":")[1]
            }));
        }
    })();

    async function generateAccount(username: string, password: string, proxy: HttpsProxyAgent) {
        console.log(`[${threadId}] Generating account ${username}:${password}`);
    
        const id = await createAlias(username);
        if(id == -1) {
            throw new Error('Mailbox creation failed');
        }
    
        const sitekey = "4c672d35-0701-42b2-88c3-78380b0db560";
    
        const captchaKey = await solveCaptcha(sitekey, "discord.com");
        console.log(`[${threadId}] Captcha solved !`);
    
        const fingerprint = (await axios.get('https://discord.com/api/v9/experiments')).data.fingerprint;
        console.log(`[${threadId}] Fingerprint: ${fingerprint}`);
    
        const data = (await axios.post('https://discord.com/api/v9/auth/register', {
            captcha_key: captchaKey,
            consent: true,
            date_of_birth: (Math.floor(Math.random() * (2001 - 1990 + 1)) + 1990).toString() + "-" + (Math.floor(Math.random() * 12) + 1).toString() + "-" + (Math.floor(Math.random() * 28) + 1).toString(),
            email: username + "@" + process.env.MAILCOW_DOMAIN,
            fingerprint: fingerprint,
            gift_code_sku_id: null,
            invite: null,
            password,
            promotional_email_opt_in: false,
            username
        }, {
            headers: {
                'X-Fingerprint': fingerprint,
                'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJmciIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEwMC4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEwMC4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTAwLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6IiIsInJlZmVycmluZ19kb21haW4iOiIiLCJyZWZlcnJlcl9jdXJyZW50IjoiIiwicmVmZXJyaW5nX2RvbWFpbl9jdXJyZW50IjoiIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6MTI3MTM1LCJjbGllbnRfZXZlbnRfc291cmNlIjpudWxsfQ=='
            },
            validateStatus: (status) => true
        })).data;

        if(!data.token) {
            console.log(data);
            throw new Error('Registration failed');
        }

        console.log(`[${threadId}] Account created !`);

        await saveToDatabase(username, username + "@" + process.env.MAILCOW_DOMAIN, password,  data.token);
        //await deleteAlias(id);
    }
    
    function createAlias(name : string) : Promise<number> {
        return new Promise((resolve, reject) => {
            axios.post(`${process.env.MAILCOW_HOST}/api/v1/add/alias`, {
                address: name + "@" + process.env.MAILCOW_DOMAIN,
                goto: process.env.MAILCOW_DESTINATION,
                goto_null: false,
                goto_spam: false,
                goto_ham: false,
                active: true
            }, {
                headers: {
                    'X-API-Key': process.env.MAILCOW_API_KEY
                }
            }).then(res => {   
                const json = res.data; 
                 if(json[0].type === 'success') {
                     resolve(parseInt(json[0].msg[json[0].msg.length - 1]));
                 } else {
                     resolve(-1);
                 }
            })
        })
    }
    
    function deleteAlias(id: number) : Promise<boolean> {
        return new Promise((resolve, reject) => {
            axios.post(`${process.env.MAILCOW_HOST}/api/v1/delete/alias`, {
                json: [
                    id
                ]
            }, {
                headers: {
                    'X-API-Key': process.env.MAILCOW_API_KEY
                }
            }).then(res => {   
                const json = res.data;
                 if(json[0].type === 'success') {
                     resolve(true);
                 } else {
                     resolve(false);
                 }
            })
        })
    }
    
    async function saveToDatabase(name: string, email: string, password: string, token: string) {
        let conn;
        try {
            conn = await pool.getConnection();
            await conn.query('INSERT INTO accounts (name, email, password, token) VALUES (?, ?, ?, ?)', [name, email, password, token]);
        } finally {
            if(conn) conn.release();
        }
    }
}
