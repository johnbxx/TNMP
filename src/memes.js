import { STATE } from './config.js';

const TOO_EARLY_IMAGES = [
    'memes/too_early_1.webp',
    'memes/too_early_2.webp',
    'memes/too_early_3.webp',
    'memes/too_early_4.webp',
    'memes/too_early_5.webp',
];

const NO_IMAGES = [
    'memes/no_1.webp',
    'memes/no_2.webp',
    'memes/no_3.webp',
    'memes/no_4.webp',
    'memes/no_5.webp',
    'memes/no_6.webp',
    'memes/no_7.webp',
    'memes/no_8.webp',
    'memes/no_9.webp',
    'memes/no_10.webp',
    'memes/no_11.webp',
];

const YES_IMAGES = [
    'memes/yes_1.webp',
    'memes/yes_2.webp',
    'memes/yes_3.webp',
    'memes/yes_4.webp',
    'memes/yes_5.webp',
    'memes/yes_6.webp',
    'memes/yes_7.webp',
    'memes/yes_8.webp',
];

const IN_PROGRESS_IMAGES = [
    'memes/in_progress_1.webp',
    'memes/in_progress_2.webp',
    'memes/in_progress_3.webp',
];

const RESULTS_IMAGES = [
    'memes/results_1.webp',
    'memes/results_2.webp',
    'memes/results_3.webp',
    'memes/results_4.webp',
    'memes/results_5.webp',
    'memes/results_6.webp',
    'memes/results_7.webp',
    'memes/results_8.webp',
    'memes/results_9.webp',
];

const YES_CAPTIONS = [
    "IT'S HAPPENING!",
    "Time to see who I'm crushing tonight!",
    "Finally! Let's gooooo!",
    "Prepare yourselves... the pairings have arrived!",
    "The moment we've all been waiting for!",
    "LET'S GO!!!"
];

const NO_CAPTIONS = [
    "One does not simply post pairings on time",
    "Still waiting...",
    "Maybe next refresh?",
    "The pairings will be posted any minute now...",
    "Any second now...",
    "Refreshing intensifies"
];

const TOO_EARLY_CAPTIONS = [
    "Patience, young grasshopper...",
    "Sir, this is not Monday night",
    "You're a bit early there, champ",
    "Whoa there, eager beaver!",
    "The pairings aren't even close to ready",
    "Come back Monday after 8pm!"
];

const IN_PROGRESS_CAPTIONS = [
    "The games are afoot!",
    "Chess is happening right now",
    "Battles are being waged as we speak",
    "Knights are jumping, bishops are sliding..."
];

const RESULTS_CAPTIONS = [
    "The results are in!",
    "Another week, another battle complete",
    "Check out how everyone did!",
    "Who crushed it? Who got crushed?",
    "The dust has settled..."
];

const MEME_DATA = {
    [STATE.YES]: { images: YES_IMAGES, captions: YES_CAPTIONS },
    [STATE.NO]: { images: NO_IMAGES, captions: NO_CAPTIONS },
    [STATE.TOO_EARLY]: { images: TOO_EARLY_IMAGES, captions: TOO_EARLY_CAPTIONS },
    [STATE.IN_PROGRESS]: { images: IN_PROGRESS_IMAGES, captions: IN_PROGRESS_CAPTIONS },
    [STATE.RESULTS]: { images: RESULTS_IMAGES, captions: RESULTS_CAPTIONS }
};

function getRandomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

export function getRandomMeme(state) {
    const data = MEME_DATA[state];
    return {
        img: getRandomItem(data.images),
        text: getRandomItem(data.captions)
    };
}
