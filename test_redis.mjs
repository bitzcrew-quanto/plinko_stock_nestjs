
import { createClient } from "redis";

async function test() {
  const subscriber = createClient({
    url: "redis://localhost:6380"
  });

  subscriber.on("error", (err) => console.error("Redis Client Error", err));

  await subscriber.connect();
  let usaCount = 0;
  let nseCount = 0;
  let cryptoCount = 0;

  subscriber.subscribe(["UsaStockStream", "NseStream", "CryptoStream"], (message, channel) => {
    try {
        const data = JSON.parse(message);
        
        let shouldLog = false;
        if (channel === "UsaStockStream" && usaCount < 3) { usaCount++; shouldLog = true; }
        if (channel === "NseStream" && nseCount < 3) { nseCount++; shouldLog = true; }
        if (channel === "CryptoStream" && cryptoCount < 3) { cryptoCount++; shouldLog = true; }
        
        if (shouldLog) {
            console.log(`
[RAW ${channel}] Timestamp: ${JSON.stringify(data.timestamp)}`);
            const firstSymbol = Object.entries(data.symbols)[0];
            console.log(`[RAW ${channel}] Symbol [${firstSymbol[0]}]: ${JSON.stringify(firstSymbol[1])}`);
        }
    } catch(e) {}
  });

  setTimeout(() => {
    subscriber.unsubscribe();
    subscriber.quit();
    process.exit(0);
  }, 10000);
}

test();

