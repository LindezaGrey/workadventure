import { JITSI_URL } from "../Enum/EnvironmentVariable";
import { coWebsiteManager } from "./CoWebsiteManager";
import { requestedCameraState, requestedMicrophoneState } from "../Stores/MediaStore";
import { get } from "svelte/store";
import CancelablePromise from "cancelable-promise";
import { gameManager } from "../Phaser/Game/GameManager";
import { jitsiParticipantsCountStore, userIsJitsiDominantSpeakerStore } from "../Stores/GameStore";
import { z } from "zod";

const JitsiConfig = z
    .object({
        startWithAudioMuted: z.boolean().optional(),
        startWithVideoMuted: z.boolean().optional(),
        prejoinPageEnabled: z.boolean().optional(),
        disableDeepLinking: z.boolean().optional(),
    })
    .passthrough();

type JitsiConfig = z.infer<typeof JitsiConfig>;

interface JitsiOptions {
    jwt?: string;
    roomName: string;
    width: string;
    height: string;
    parentNode: HTMLElement;
    configOverwrite: JitsiConfig;
    interfaceConfigOverwrite: typeof defaultInterfaceConfig;
    onload?: () => void;
}

interface JitsiApi {
    executeCommand: (command: string, ...args: Array<unknown>) => void;
    addListener: (type: string, callback: Function) => void; //eslint-disable-line @typescript-eslint/ban-types
    removeListener: (type: string, callback: Function) => void; //eslint-disable-line @typescript-eslint/ban-types
    getParticipantsInfo(): { displayName: string; participantId: string }[];
    dispose: () => void;
}

declare global {
    interface Window {
        JitsiMeetExternalAPI: new (domain: string, options: JitsiOptions) => JitsiApi;
    }
}

const getDefaultConfig = (): JitsiConfig => {
    return {
        startWithAudioMuted: !get(requestedMicrophoneState),
        startWithVideoMuted: !get(requestedCameraState),
        prejoinPageEnabled: false,
        disableDeepLinking: false,
    };
};

const mergeConfig = (config?: object) => {
    const currentDefaultConfig = getDefaultConfig();
    if (!config) {
        return currentDefaultConfig;
    }

    const parsedConfig = JitsiConfig.parse(config);

    return {
        ...currentDefaultConfig,
        ...config,
        startWithAudioMuted: parsedConfig.startWithAudioMuted ? true : currentDefaultConfig.startWithAudioMuted,
        startWithVideoMuted: parsedConfig.startWithVideoMuted ? true : currentDefaultConfig.startWithVideoMuted,
        prejoinPageEnabled: parsedConfig.prejoinPageEnabled ? true : currentDefaultConfig.prejoinPageEnabled,
    };
};

const defaultInterfaceConfig = {
    SHOW_CHROME_EXTENSION_BANNER: false,
    MOBILE_APP_PROMO: false,

    HIDE_INVITE_MORE_HEADER: true,
    DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
    DISABLE_VIDEO_BACKGROUND: true,

    // Note: hiding brand does not seem to work, we probably need to put this on the server side.
    SHOW_BRAND_WATERMARK: false,
    SHOW_JITSI_WATERMARK: false,
    SHOW_POWERED_BY: false,
    SHOW_PROMOTIONAL_CLOSE_PAGE: false,
    SHOW_WATERMARK_FOR_GUESTS: false,

    TOOLBAR_BUTTONS: [
        "microphone",
        "camera",
        "closedcaptions",
        "desktop",
        /*'embedmeeting',*/ "fullscreen",
        "fodeviceselection",
        "hangup",
        "profile",
        "chat",
        "recording",
        "livestreaming",
        "etherpad",
        "sharedvideo",
        "settings",
        "raisehand",
        "videoquality",
        "filmstrip",
        /*'invite',*/ "feedback",
        "stats",
        "shortcuts",
        "tileview",
        "videobackgroundblur",
        "select-background",
        "download",
        "help",
        "mute-everyone" /*'security'*/,
    ],
};

class JitsiFactory {
    private jitsiApi?: JitsiApi;
    private audioCallback = this.onAudioChange.bind(this);
    private videoCallback = this.onVideoChange.bind(this);
    private dominantSpeakerChangedCallback = this.onDominantSpeakerChanged.bind(this);
    private participantsCountChangeCallback = this.onParticipantsCountChange.bind(this);
    private jitsiScriptLoaded = false;

    public start(
        roomName: string,
        playerName: string,
        jwt?: string,
        config?: object,
        interfaceConfig?: object,
        jitsiUrl?: string
    ): CancelablePromise<HTMLIFrameElement> {
        return new CancelablePromise((resolve, reject, cancel) => {
            // Jitsi meet external API maintains some data in local storage
            // which is sent via the appData URL parameter when joining a
            // conference. Problem is that this data grows indefinitely. Thus,
            // after some time the URLs get so huge that loading the iframe
            // becomes slow and eventually breaks completely. Thus lets just
            // clear jitsi local storage before starting a new conference.
            window.localStorage.removeItem("jitsiLocalStorage");

            const domain = jitsiUrl || JITSI_URL;
            if (domain === undefined) {
                throw new Error("Missing JITSI_URL environment variable or jitsiUrl parameter in the map.");
            }

            const loadScript = this.loadJitsiScript(domain).then(() => {
                const options: JitsiOptions = {
                    roomName: roomName,
                    jwt: jwt,
                    width: "100%",
                    height: "100%",
                    parentNode: coWebsiteManager.getCoWebsiteBuffer(),
                    configOverwrite: mergeConfig(config),
                    interfaceConfigOverwrite: { ...defaultInterfaceConfig, ...interfaceConfig },
                };

                if (!options.jwt) {
                    delete options.jwt;
                }

                const timemout = setTimeout(() => doResolve(), 2000); //failsafe in case the iframe is deleted before loading or too long to load

                const doResolve = (): void => {
                    clearTimeout(timemout);
                    const iframe = coWebsiteManager
                        .getCoWebsiteBuffer()
                        .querySelector<HTMLIFrameElement>('[id*="jitsi" i]');

                    if (iframe && this.jitsiApi) {
                        this.jitsiApi.addListener("videoConferenceLeft", () => {
                            this.closeOrUnload(iframe);
                        });

                        this.jitsiApi.addListener("readyToClose", () => {
                            this.closeOrUnload(iframe);
                        });

                        return resolve(iframe);
                    }
                };

                this.jitsiApi = undefined;

                options.onload = () => doResolve(); //we want for the iframe to be loaded before triggering animations.
                this.jitsiApi = new window.JitsiMeetExternalAPI(domain, options);

                this.jitsiApi.addListener("videoConferenceJoined", () => {
                    this.jitsiApi?.executeCommand("displayName", playerName);
                    this.updateParticipantsCountStore();
                });

                this.jitsiApi.addListener("audioMuteStatusChanged", this.audioCallback);
                this.jitsiApi.addListener("videoMuteStatusChanged", this.videoCallback);
                this.jitsiApi.addListener("dominantSpeakerChanged", this.dominantSpeakerChangedCallback);
                this.jitsiApi.addListener("participantJoined", this.participantsCountChangeCallback);
                this.jitsiApi.addListener("participantLeft", this.participantsCountChangeCallback);
                this.jitsiApi.addListener("participantKickedOut", this.participantsCountChangeCallback);
            });

            cancel(() => {
                loadScript.cancel();
            });
        });
    }

    private closeOrUnload = function (iframe: HTMLIFrameElement) {
        const coWebsite = coWebsiteManager.getCoWebsites().find((coWebsite) => coWebsite.getIframe() === iframe);

        if (!coWebsite) {
            return;
        }

        if (coWebsite.isClosable()) {
            coWebsiteManager.closeCoWebsite(coWebsite);
        } else {
            coWebsiteManager.unloadCoWebsite(coWebsite).catch((err) => {
                console.error("Cannot unload co-website from the Jitsi factory", err);
            });
        }
    };

    public stop() {
        if (!this.jitsiApi) {
            return;
        }

        this.jitsiApi.removeListener("audioMuteStatusChanged", this.audioCallback);
        this.jitsiApi.removeListener("videoMuteStatusChanged", this.videoCallback);
    }

    public destroy() {
        userIsJitsiDominantSpeakerStore.set(false);
        jitsiParticipantsCountStore.set(0);
        if (!this.jitsiApi) {
            return;
        }

        this.stop();
        this.jitsiApi?.dispose();
    }

    private onAudioChange({ muted }: { muted: boolean }): void {
        if (muted) {
            requestedMicrophoneState.disableMicrophone();
        } else {
            requestedMicrophoneState.enableMicrophone();
        }
    }

    private onVideoChange({ muted }: { muted: boolean }): void {
        if (muted) {
            requestedCameraState.disableWebcam();
        } else {
            requestedCameraState.enableWebcam();
        }
    }

    private onDominantSpeakerChanged(data: { id: string }): void {
        if (this.jitsiApi) {
            userIsJitsiDominantSpeakerStore.set(
                data.id === this.getCurrentParticipantId(this.jitsiApi.getParticipantsInfo())
            );
        }
    }

    private onParticipantsCountChange(): void {
        this.updateParticipantsCountStore();
    }

    private updateParticipantsCountStore(): void {
        jitsiParticipantsCountStore.set(this.jitsiApi?.getParticipantsInfo().length ?? 0);
    }

    private getCurrentParticipantId(
        participants: { displayName: string; participantId: string }[]
    ): string | undefined {
        const currentPlayerName = gameManager.getPlayerName();
        for (const participant of participants) {
            if (participant.displayName === currentPlayerName) {
                return participant.participantId;
            }
        }
        return;
    }

    private loadJitsiScript(domain: string): CancelablePromise<void> {
        return new CancelablePromise<void>((resolve, reject, cancel) => {
            if (this.jitsiScriptLoaded) {
                resolve();
                return;
            }

            this.jitsiScriptLoaded = true;

            // Load Jitsi if the environment variable is set.
            const jitsiScript = document.createElement("script");
            if (!domain.startsWith("https://")) {
                domain = "https://" + domain;
            }
            jitsiScript.src = domain + "/external_api.js";
            jitsiScript.onload = () => {
                resolve();
            };
            jitsiScript.onerror = () => {
                reject();
            };

            document.head.appendChild(jitsiScript);

            cancel(() => {
                jitsiScript.remove();
            });
        });
    }
}

export const jitsiFactory = new JitsiFactory();
