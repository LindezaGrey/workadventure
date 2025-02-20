import type { PointInterface } from "./PointInterface";
import type { Identificable } from "./Identificable";
import type { ViewportInterface } from "./ViewportMessage";
import type { ClientDuplexStream } from "@grpc/grpc-js";
import type { Zone } from "../Zone";
import type { compressors } from "hyper-express";
import type {
    WokaDetail,
    MucRoomDefinition,
    ApplicationDefinitionInterface,
    CompanionMessage,
    SubMessage,
    BatchMessage,
    PusherToBackMessage,
    ServerToClientMessage,
} from "@workadventure/messages";
import type { PusherRoom } from "../PusherRoom";
import { CustomJsonReplacerInterface } from "../CustomJsonReplacerInterface";
import { AvailabilityStatus } from "@workadventure/messages";

export type BackConnection = ClientDuplexStream<PusherToBackMessage, ServerToClientMessage>;

export interface ExSocketInterface extends compressors.WebSocket, Identificable, CustomJsonReplacerInterface {
    token: string;
    roomId: string;
    //userId: number;   // A temporary (autoincremented) identifier for this user
    userUuid: string; // A unique identifier for this user
    userIdentifier: string;
    userJid: string;
    isLogged: boolean;
    IPAddress: string; // IP address
    name: string;
    characterLayers: WokaDetail[];
    position: PointInterface;
    viewport: ViewportInterface;
    companion?: CompanionMessage;
    availabilityStatus: AvailabilityStatus;
    lastCommandId?: string;
    /**
     * Pushes an event that will be sent in the next batch of events
     */
    emitInBatch: (payload: SubMessage) => void;
    batchedMessages: BatchMessage;
    batchTimeout: NodeJS.Timeout | null;
    disconnecting: boolean;
    messages: unknown;
    tags: string[];
    visitCardUrl: string | null;
    backConnection: BackConnection;
    listenedZones: Set<Zone>;
    userRoomToken: string | undefined;
    maxHistoryChat: number;
    pusherRoom: PusherRoom | undefined;
    jabberId: string;
    jabberPassword: string;
    activatedInviteUser: boolean | undefined;
    mucRooms: Array<MucRoomDefinition>;
    applications: Array<ApplicationDefinitionInterface> | undefined;
    canEdit: boolean;
}
