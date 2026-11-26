import { useEffect, useState } from "react";
import { get } from "./api";
import Wallets from "./Wallets";
import { AppHome } from "./AppHome";
import { Library } from "./Library";

/**
 * The two public pages that can hold a wallet, behind one chunk.
 *
 * They are grouped rather than split one each because they share everything that makes them heavy:
 * wagmi, viem and the connect UI. Splitting them further would download the same code twice for
 * someone who buys a brief and then opens their library.
 */
export default function WalletPages({ page }: { page: "app" | "library" }) {
    return <Wallets>{page === "app" ? <AppHome /> : <LibraryPage />}</Wallets>;
}

/** The library needs the same public terms the app reads: network, asset and the price. */
function LibraryPage() {
    const [terms, setTerms] = useState<{ network: string; asset: string; briefPriceUsd: string } | null>(null);
    useEffect(() => {
        get<{ network: string; asset: string; briefPriceUsd: string }>("/catalogue")
            .then(setTerms)
            .catch(() => setTerms(null));
    }, []);
    return <Library terms={terms} />;
}
