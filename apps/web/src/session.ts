import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Whether a connected wallet is the owner's.
 *
 * Case-insensitive because one side is a checksummed address from a wallet and the other is whatever
 * was typed into the environment, and an address that differs only in capitalisation is the same
 * address. Absent on either side is not a match: a page that has read nothing must not guess.
 */
export function isOwnerWallet(connected: string | null, owner: string | null | undefined): boolean {
    if (connected === null || owner === undefined || owner === null || owner === "") return false;
    return connected.toLowerCase() === owner.toLowerCase();
}

/**
 * Whether the owner has a live session, for surfaces that should not advertise the desk to a stranger.
 *
 * There is exactly one owner and everyone else is a buyer, so a link to the desk is, for almost
 * every visitor, a door they cannot open and a hint that the page is not really for them. It is not
 * a security control: `/desk` is reachable by typing it, and the routes behind it are gated by the
 * owner's signature rather than by whether a button was rendered. This only stops the page offering
 * something the person looking at it has no use for.
 *
 * A session is not the only way to recognise the owner, and on its own it is a circular test: the
 * button exists to reach the page where you sign in, so hiding it until you have signed in hides it
 * exactly when it is wanted. `isOwnerWallet` is the other half, and the two are combined by the
 * caller, because a session survives a disconnected wallet and a connected wallet precedes a session.
 *
 * Fails closed. An unreachable API means no button, because showing one that leads to a sign-in wall
 * is worse than not showing it at all.
 */
export function useOwnerSignedIn(): boolean {
    const [signedIn, setSignedIn] = useState(false);

    useEffect(() => {
        let live = true;
        api.me()
            .then((me) => { if (live) setSignedIn(me.signedIn && me.address !== null); })
            .catch(() => { if (live) setSignedIn(false); });
        return () => { live = false; };
    }, []);

    return signedIn;
}
