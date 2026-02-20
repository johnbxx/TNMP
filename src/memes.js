import { STATE } from './config.js';

const MEME_DATA = {
    [STATE.TOO_EARLY]: { count: 5, captions: [
        "Patience, young grasshopper...",
        "Sir, this is not Monday night",
        "You're a bit early there, champ",
        "Whoa there, eager beaver!",
        "The pairings aren't even close to ready",
        "Come back Monday after 8pm!",
    ]},
    [STATE.NO]: { count: 11, captions: [
        "One does not simply post pairings on time",
        "Still waiting...",
        "Maybe next refresh?",
        "The pairings will be posted any minute now...",
        "Any second now...",
        "Refreshing intensifies",
    ]},
    [STATE.YES]: { count: 8, captions: [
        "IT'S HAPPENING!",
        "Time to see who I'm crushing tonight!",
        "Finally! Let's gooooo!",
        "Prepare yourselves... the pairings have arrived!",
        "The moment we've all been waiting for!",
        "LET'S GO!!!",
    ]},
    [STATE.IN_PROGRESS]: { count: 3, captions: [
        "The games are afoot!",
        "Chess is happening right now",
        "Battles are being waged as we speak",
        "Knights are jumping, bishops are sliding...",
    ]},
    [STATE.RESULTS]: { count: 9, captions: [
        "The results are in!",
        "Another week, another battle complete",
        "Check out how everyone did!",
        "Who crushed it? Who got crushed?",
        "The dust has settled...",
    ]},
};

export function getRandomMeme(state) {
    const data = MEME_DATA[state];
    const n = Math.floor(Math.random() * data.count) + 1;
    return {
        img: `memes/${state}_${n}.webp`,
        text: data.captions[Math.floor(Math.random() * data.captions.length)],
    };
}
