import glpk from 'glpk.js/node';

async function test() {
    try {
        console.log("Initializing GLPK...");
        const glp = await (glpk as any)();
        console.log("GLPK initialized successfully. Version:", glp.version);
        process.exit(0);
    } catch (err: any) {
        console.error("GLPK Initialization failed:", err);
        process.exit(1);
    }
}

test();
