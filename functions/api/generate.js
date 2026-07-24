/**
 * Generate Temp Email API
 * Creates human-like email addresses with uniqueness check
 */

// Extended human-like name components
const firstNames = [
    // English names
    'james', 'john', 'robert', 'michael', 'david', 'william', 'richard', 'joseph', 'thomas', 'charles',
    'mary', 'patricia', 'jennifer', 'linda', 'elizabeth', 'barbara', 'susan', 'jessica', 'sarah', 'karen',
    'alex', 'chris', 'jordan', 'taylor', 'morgan', 'casey', 'riley', 'jamie', 'drew', 'blake',
    'emma', 'olivia', 'ava', 'sophia', 'mia', 'luna', 'chloe', 'ella', 'grace', 'lily',
    'liam', 'noah', 'oliver', 'lucas', 'mason', 'logan', 'ethan', 'aiden', 'jack', 'ryan',
    // Indian names
    'arjun', 'rahul', 'priya', 'aisha', 'ravi', 'neha', 'vikram', 'ananya', 'rohan', 'kavya',
    'amit', 'pooja', 'sanjay', 'meera', 'karan', 'shreya', 'varun', 'divya', 'nikhil', 'tanya',
    // International names
    'omar', 'sara', 'ali', 'zara', 'yusuf', 'layla', 'adam', 'nadia', 'hassan', 'fatima',
    'leo', 'mila', 'max', 'nina', 'felix', 'anna', 'oscar', 'elena', 'hugo', 'clara',
    'kai', 'hana', 'yuki', 'sakura', 'ren', 'mei', 'jin', 'sora', 'ryu', 'akira',
    // Modern/Trendy names
    'nova', 'phoenix', 'river', 'sage', 'sky', 'storm', 'winter', 'aurora', 'violet', 'ivy',
    'axel', 'zane', 'cole', 'dane', 'finn', 'gray', 'jace', 'knox', 'reid', 'theo',
    // Tech-inspired names
    'dev', 'code', 'byte', 'pixel', 'cyber', 'neo', 'tech', 'data', 'cloud', 'crypto'
];

const lastNames = [
    // English surnames
    'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'martinez', 'wilson',
    'anderson', 'taylor', 'thomas', 'moore', 'jackson', 'martin', 'lee', 'thompson', 'white', 'harris',
    'clark', 'lewis', 'robinson', 'walker', 'young', 'allen', 'king', 'wright', 'scott', 'green',
    'baker', 'adams', 'nelson', 'hill', 'campbell', 'mitchell', 'roberts', 'carter', 'phillips', 'evans',
    'turner', 'torres', 'parker', 'collins', 'edwards', 'stewart', 'morris', 'murphy', 'rivera', 'cook',
    // Indian surnames  
    'sharma', 'patel', 'khan', 'singh', 'kumar', 'gupta', 'verma', 'joshi', 'reddy', 'rao',
    'mehta', 'shah', 'mishra', 'chauhan', 'nair', 'iyer', 'pillai', 'menon', 'bhatia', 'chopra',
    // International surnames
    'kim', 'chen', 'wang', 'zhang', 'li', 'liu', 'yang', 'huang', 'zhao', 'wu',
    'sato', 'suzuki', 'tanaka', 'yamamoto', 'watanabe', 'ito', 'nakamura', 'kobayashi', 'kato', 'yoshida',
    'silva', 'santos', 'ferreira', 'oliveira', 'costa', 'pereira', 'almeida', 'carvalho', 'rocha', 'lima'
];

const adjectives = [
    'cool', 'epic', 'pro', 'real', 'fast', 'smart', 'quick', 'super', 'mega', 'ultra',
    'happy', 'lucky', 'sunny', 'brave', 'swift', 'bright', 'sharp', 'sleek', 'bold', 'prime'
];

const nouns = [
    'wolf', 'hawk', 'tiger', 'eagle', 'lion', 'bear', 'fox', 'dragon', 'phoenix', 'panther',
    'coder', 'ninja', 'wizard', 'master', 'guru', 'chief', 'boss', 'king', 'ace', 'star'
];

const separators = ['.', '_', ''];
const yearSuffixes = ['90', '91', '92', '93', '94', '95', '96', '97', '98', '99', '00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '20', '21', '22', '23', '24', '25'];
const numberSuffixes = ['1', '2', '3', '4', '5', '7', '8', '9', '11', '12', '21', '22', '33', '42', '55', '66', '69', '77', '88', '99', '100', '123', '007', '321', '420', '777', '999'];

export async function onRequestPost(context) {
    try {
        const { env, request } = context;

        // Check for a valid session token (authenticated users get unlimited generations)
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        let isAuthenticated = false;
        if (token) {
            const session = await env.EMAILS.get(`session:${token}`);
            if (session) isAuthenticated = true;
        }

        // Apply IP-based rate limiting for unauthenticated requests
        if (!isAuthenticated) {
            const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const rlKey = `ratelimit:gen:${ip}:${today}`;
            const count = parseInt((await env.EMAILS.get(rlKey)) || '0', 10);
            if (count >= 30) {
                return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again tomorrow.' }), {
                    status: 429,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
            await env.EMAILS.put(rlKey, String(count + 1), { expirationTtl: 86400 });
        }

        // Generate unique human-like email with retry logic
        let email;
        let attempts = 0;
        const maxAttempts = 5;

        do {
            email = generateHumanEmail();
            const exists = await env.TEMP_EMAILS.get(email);
            if (!exists) break;
            attempts++;
        } while (attempts < maxAttempts);

        // If still not unique, add timestamp
        if (attempts >= maxAttempts) {
            const timestamp = Date.now().toString(36).slice(-4);
            email = email.replace('@', timestamp + '@');
        }

        // Store in KV
        const emailData = {
            createdAt: Date.now(),
            expiresAt: Date.now() + 3600000,
        };

        await env.TEMP_EMAILS.put(
            email,
            JSON.stringify(emailData),
            { expirationTtl: 3600 }
        );

        return new Response(
            JSON.stringify({ email }),
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-store'
                }
            }
        );
    } catch (error) {
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            }
        );
    }
}

function generateHumanEmail() {
    const patterns = [
        // firstname.lastname (most common)
        () => {
            const first = randomChoice(firstNames);
            const last = randomChoice(lastNames);
            const sep = randomChoice(separators);
            return `${first}${sep}${last}`;
        },
        // firstname.lastname + year
        () => {
            const first = randomChoice(firstNames);
            const last = randomChoice(lastNames);
            const sep = randomChoice(separators);
            const year = randomChoice(yearSuffixes);
            return `${first}${sep}${last}${year}`;
        },
        // firstname.lastname + number
        () => {
            const first = randomChoice(firstNames);
            const last = randomChoice(lastNames);
            const sep = randomChoice(separators);
            const num = randomChoice(numberSuffixes);
            return `${first}${sep}${last}${num}`;
        },
        // firstname + number
        () => {
            const first = randomChoice(firstNames);
            const num = randomChoice([...yearSuffixes, ...numberSuffixes]);
            return `${first}${num}`;
        },
        // first initial + lastname + number
        () => {
            const first = randomChoice(firstNames);
            const last = randomChoice(lastNames);
            const num = randomChoice(numberSuffixes);
            return `${first[0]}${last}${num}`;
        },
        // firstname + last initial + number
        () => {
            const first = randomChoice(firstNames);
            const last = randomChoice(lastNames);
            const num = randomChoice(yearSuffixes);
            return `${first}${last[0]}${num}`;
        },
        // firstname.middle_initial.lastname
        () => {
            const first = randomChoice(firstNames);
            const middle = randomChoice(firstNames)[0];
            const last = randomChoice(lastNames);
            return `${first}.${middle}.${last}`;
        },
        // the.firstname
        () => {
            const first = randomChoice(firstNames);
            const num = Math.random() > 0.5 ? randomChoice(numberSuffixes) : '';
            return `the.${first}${num}`;
        },
        // firstname.official/real/pro
        () => {
            const first = randomChoice(firstNames);
            const suffix = randomChoice(['real', 'official', 'hq', 'pro', 'vip', 'main']);
            return `${first}.${suffix}`;
        },
        // adjective + noun + number
        () => {
            const adj = randomChoice(adjectives);
            const noun = randomChoice(nouns);
            const num = randomChoice(numberSuffixes);
            return `${adj}${noun}${num}`;
        },
        // firstname.from.city
        () => {
            const first = randomChoice(firstNames);
            const cities = ['nyc', 'la', 'chi', 'miami', 'london', 'paris', 'tokyo', 'delhi', 'mumbai', 'dubai'];
            const city = randomChoice(cities);
            return `${first}.from.${city}`;
        },
        // mr/ms firstname
        () => {
            const prefix = randomChoice(['mr', 'ms', 'dr', 'prof']);
            const first = randomChoice(firstNames);
            const num = Math.random() > 0.6 ? randomChoice(numberSuffixes) : '';
            return `${prefix}.${first}${num}`;
        },
        // firstname + random adjective
        () => {
            const first = randomChoice(firstNames);
            const adj = randomChoice(adjectives);
            return `${adj}${first}`;
        },
        // double firstname
        () => {
            const first = randomChoice(firstNames);
            const second = randomChoice(firstNames);
            const sep = randomChoice(separators);
            return `${first}${sep}${second}`;
        },
        // firstname + work-related
        () => {
            const first = randomChoice(firstNames);
            const work = randomChoice(['work', 'jobs', 'biz', 'office', 'mail', 'inbox', 'temp', 'personal']);
            return `${first}.${work}`;
        }
    ];

    const pattern = randomChoice(patterns);
    const localPart = pattern().toLowerCase();

    return `${localPart}@unknownlll2829.qzz.io`;
}

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}
