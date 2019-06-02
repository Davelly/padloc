import {
    bytesToBase64,
    base64ToBytes,
    bytesToString,
    stringToBytes,
    Serializable,
    unmarshal,
    marshal,
    concatBytes
} from "./encoding";
import {
    getProvider,
    RSAPrivateKey,
    RSAPublicKey,
    AESKey,
    RSAKeyParams,
    AESKeyParams,
    RSASigningParams
} from "./crypto";
import { SharedContainer } from "./container";
import { Err, ErrorCode } from "./error";
import { Storable } from "./storage";
import { Vault, VaultID } from "./vault";
import { Account, AccountID } from "./account";
import { Invite, InviteID } from "./invite";
import { OrgQuota } from "./quota";
import { BillingInfo } from "./billing";

/** Role of a member within an organization, each associated with certain priviliges */
export enum OrgRole {
    /**
     * Organization owner. Can manage members, groups and vaults.  Owners have
     * access to the secret [[Org.privateKey]] and [[Org.invitesKey]]
     * properties.
     */
    Owner,
    /**
     * Organization admin. Can manage groups and vaults.
     */
    Admin,
    /**
     * Basic organization member. Can read public organization data and read/write
     * certain [[Vault]]s they have been assigned to directly or via [[Group]]s.
     */
    Member,
    /**
     * Suspended members can read public organization data and access [[Vaults]] they
     * have been assigned to, but are excluded from any updates to those vaults.
     * Member information (like public key and email address) of suspended members
     * are considered unverified, and need to be updated and verified via a
     * membership confirmation [[Invite]].
     */
    Suspended
}

/**
 * Represents an [[Account]]s membership to an [[Org]]
 */
export class OrgMember extends Serializable {
    /** id of the corresponding [[Account]] */
    id: AccountID = "";

    /** name of the corresponding [[Account]] */
    name = "";

    /** email address of the corresponding [[Account]] */
    email = "";

    /** public key of the corresponding [[Account]] */
    publicKey!: RSAPublicKey;

    /** signature used by other members to verify [[id]], [[email]] and [[publicKey]] */
    signature!: Uint8Array;

    /** signature used by the member to verify [[Org.id]] and [[Org.publickey]] of the organization */
    orgSignature!: Uint8Array;

    /** vaults assigned to this member */
    vaults: {
        id: VaultID;
        readonly: boolean;
    }[] = [];

    /** the members organization role */
    role: OrgRole = OrgRole.Member;

    constructor({ id, name, email, publicKey, signature, orgSignature, role }: Partial<OrgMember> = {}) {
        super();
        Object.assign(this, { id, name, email, publicKey, signature, orgSignature });
        this.role = typeof role !== "undefined" && role in OrgRole ? role : OrgRole.Member;
    }

    toRaw(): any {
        return {
            ...super.toRaw(),
            publicKey: bytesToBase64(this.publicKey),
            signature: bytesToBase64(this.signature),
            orgSignature: bytesToBase64(this.orgSignature)
        };
    }

    validate() {
        return (
            typeof this.id === "string" &&
            typeof this.name === "string" &&
            typeof this.email === "string" &&
            this.role in OrgRole &&
            this.publicKey instanceof Uint8Array &&
            this.signature instanceof Uint8Array &&
            this.orgSignature instanceof Uint8Array &&
            this.vaults.every(({ id, readonly }: any) => typeof id === "string" && typeof readonly === "boolean")
        );
    }

    fromRaw({ id, name, email, publicKey, signature, orgSignature, role, vaults }: any) {
        return super.fromRaw({
            id,
            name,
            email,
            publicKey: base64ToBytes(publicKey),
            signature: base64ToBytes(signature),
            orgSignature: base64ToBytes(orgSignature),
            role,
            vaults
        });
    }
}

/**
 * A group of members, used to manage [[Vault]] access for multiple members at once.
 */
export class Group extends Serializable {
    /** display name */
    name = "";
    /** members assigned to this group */
    members: { id: AccountID }[] = [];
    /** [[Vault]]s assigned to this group */
    vaults: {
        id: VaultID;
        readonly: boolean;
    }[] = [];

    validate() {
        return (
            typeof this.name === "string" &&
            this.members.every(({ id }: any) => typeof id === "string") &&
            this.vaults.every(({ id, readonly }: any) => typeof id === "string" && typeof readonly === "boolean")
        );
    }

    fromRaw({ name, members, vaults }: any) {
        return super.fromRaw({
            name,
            members,
            vaults
        });
    }
}

/** Unique identifier for [[Org]]s */
export type OrgID = string;

export enum OrgType {
    Basic,
    Team,
    Business
}

/**
 * Organizations are the central component of Padlocs secure data sharing architecture.
 *
 * All shared [[Vault]]s are provisioned and managed in the context of an organization,
 * while the [[Org]] class itself is responsible for managing, signing and verifying
 * public keys, identities and priviliges for all of it's members.
 *
 * Vaults can be assigned to members direcly or indirectly through [[Group]]s. In both
 * cases, this access can be declared *readonly*.
 *
 * Before being added to an organization, members need to go throug a key exchange
 * procedure designed to allow verification of organization and member details
 * by both parties. See [[Invite]] class for details.
 *
 * The [[privateKey]] and [[invitesKey]] properties are considered secret and are only
 * accessible to members with the [[OrgRole.Owner]] role. To protect this information
 * from unauthorized access, [[Org]] extends the [[SharedContainer]] class, encrypting
 * this data at rest.
 *
 * #### Organization Structure
 * ```
 * ┌──────────────┐            ┌──────────────┐            ┌──────────────┐
 * │              │           ╱│              │╲           │              │
 * │   Account    │┼─────────○─│  Membership  │──┼────────┼│ Organization │
 * │              │           ╲│              │╱           │              │
 * └──────────────┘            └───┬──────┬───┘            └──────────────┘
 *                                ╲│╱    ╲│╱                       ┼
 *                                 ○      ○                        ○
 *                                 │      │                       ╱│╲
 *                                 │      │                ┌──────────────┐
 *                                 │      │               ╱│              │
 *                                 │      └──────────────○─│    Group     │
 *                                 │                      ╲│              │
 *                                 ○                       └──────────────┘
 *                                ╱│╲                             ╲│╱
 *                         ┌──────────────┐                        ○
 *                         │              │╲                       │
 *                         │ Shared Vault │─○──────────────────────┘
 *                         │              │╱
 *                         └──────────────┘
 * ```
 */
export class Org extends SharedContainer implements Storable {
    /** Unique identier */
    id: OrgID = "";

    type: OrgType = OrgType.Basic;

    /** [[Account]] which created this organization */
    owner: AccountID = "";

    /** Organization name */
    name: string = "";

    /** Public key used for verifying member signatures */
    publicKey!: RSAPublicKey;

    /**
     * Private key used for signing member details
     *
     * @secret
     * **IMPORTANT**: This property is considered **secret**
     * and should never stored or transmitted in plain text
     */
    privateKey!: RSAPrivateKey;

    /**
     * AES key used as encryption key for [[Invite]]s
     *
     * @secret
     * **IMPORTANT**: This property is considered **secret**
     * and should never stored or transmitted in plain text
     */
    invitesKey!: AESKey;

    /** Parameters for creating member signatures */
    signingParams = new RSASigningParams();

    /** Array of organization members */
    members: OrgMember[] = [];

    /** This organizations [[Group]]s. */
    groups: Group[] = [];

    /** Shared [[Vault]]s owned by this organization */
    vaults: { id: VaultID; name: string }[] = [];

    /** Pending [[Invite]]s */
    invites: Invite[] = [];

    /**
     * Revision id used for ensuring continuity when synchronizing the account
     * object between client and server
     */
    revision: string = "";

    quota: OrgQuota = new OrgQuota();

    billing?: BillingInfo;

    toRaw() {
        return {
            ...super.toRaw(["privateKey", "invitesKey"]),
            publicKey: this.publicKey && bytesToBase64(this.publicKey)
        };
    }

    validate() {
        return (
            super.validate() &&
            (typeof this.name === "string" &&
                typeof this.revision === "string" &&
                typeof this.id === "string" &&
                this.type in OrgType &&
                this.vaults.every(({ id, name }: any) => typeof id === "string" && typeof name === "string"))
        );
    }

    fromRaw({
        id,
        type,
        name,
        owner,
        revision,
        publicKey,
        members,
        groups,
        vaults,
        invites,
        signingParams,
        quota,
        billing,
        ...rest
    }: any) {
        this.signingParams.fromRaw(signingParams);
        quota && this.quota.fromRaw(quota);

        Object.assign(this, {
            id,
            type,
            name,
            owner,
            revision,
            publicKey: publicKey && base64ToBytes(publicKey),
            members: members.map((m: any) => new OrgMember().fromRaw(m)),
            groups: groups.map((g: any) => new Group().fromRaw(g)),
            invites: invites.map((g: any) => new Invite().fromRaw(g)),
            vaults,
            billing: billing && new BillingInfo().fromRaw(billing)
        });

        return super.fromRaw(rest);
    }

    /** Whether the given [[Account]] is an [[OrgRole.Owner]] */
    isOwner(m: { id: AccountID }) {
        const member = this.getMember(m);
        return member && member.role <= OrgRole.Owner;
    }

    /** Whether the given [[Account]] is an [[OrgRole.Admin]] */
    isAdmin(m: { id: AccountID }) {
        const member = this.getMember(m);
        return member && member.role <= OrgRole.Admin;
    }

    /** Get the [[OrgMember]] object for this [[Account]] */
    getMember({ id }: { id: AccountID }) {
        return this.members.find(m => m.id === id);
    }

    /** Whether the given [[Account]] is an organization member */
    isMember(acc: { id: AccountID }) {
        return !!this.getMember(acc);
    }

    /** Get group with the given `name` */
    getGroup(name: string) {
        return [...this.groups].find(g => g.name === name);
    }

    /** Get all members of a given `group` */
    getMembersForGroup(group: Group): OrgMember[] {
        return group.members
            .map(m => this.getMember(m))
            // Filter out undefined members
            .filter(m => !!m) as OrgMember[];
    }

    /** Get all [[Group]]s the given [[Account]] is a member of */
    getGroupsForMember({ id }: { id: AccountID }) {
        return this.groups.filter(g => g.members.some(m => m.id === id));
    }

    /** Get all groups assigned to a given [[Vault]] */
    getGroupsForVault({ id }: { id: VaultID }): Group[] {
        return this.groups.filter(group => group.vaults.some(v => v.id === id));
    }

    /** Get all members directly assigned to a given [[Vault]] */
    getMembersForVault({ id }: { id: VaultID }): OrgMember[] {
        return this.members.filter(member => member.role !== OrgRole.Suspended && member.vaults.some(v => v.id === id));
    }

    /** Get all membes that have acess to a given `vault`, either directly or through a [[Group]] */
    getAccessors(vault: Vault) {
        const results = new Set<OrgMember>(this.getMembersForVault(vault));

        for (const group of this.getGroupsForVault(vault)) {
            for (const m of group.members) {
                results.add(this.getMember(m)!);
            }
        }

        return [...results];
    }

    /** Get all vaults the given member has access to */
    getVaultsForMember(acc: OrgMember | Account) {
        const member = this.getMember(acc);

        if (!member) {
            throw "A member with this id does not exist!";
        }

        const results = new Set<VaultID>(member.vaults.map(v => v.id));

        for (const group of this.getGroupsForMember(member)) {
            for (const vault of group.vaults) {
                results.add(vault.id);
            }
        }

        return [...results];
    }

    /** Check whether the given `account` has read access to a `vault` */
    canRead(vault: { id: VaultID }, account: { id: AccountID }) {
        const member = this.getMember(account);

        return (
            member &&
            [member, ...this.getGroupsForMember(member)].some(({ vaults }) => vaults.some(v => v.id === vault.id))
        );
    }

    /** Check whether the given `account` has write access to a `vault` */
    canWrite(vault: { id: VaultID }, acc: { id: AccountID }) {
        const member = this.getMember(acc);

        return (
            member &&
            member.role !== OrgRole.Suspended &&
            [member, ...this.getGroupsForMember(member)].some(({ vaults }) =>
                vaults.some(v => v.id === vault.id && !v.readonly)
            )
        );
    }

    /** Get the invite with the given `id` */
    getInvite(id: InviteID) {
        return this.invites.find(inv => inv.id === id);
    }

    /** Remove an invite */
    removeInvite({ id }: Invite) {
        this.invites = this.invites.filter(inv => inv.id !== id);
    }

    /**
     * Initializes the organization, generating [[publicKey]], [[privateKey]],
     * and [[invitesKey]] and adding the given `account` as the organization
     * owner.
     */
    async initialize(account: Account) {
        // Update access to keypair
        await this.updateAccessors([account]);

        // Generate cryptographic keys
        await this.generateKeys();

        const orgSignature = await account.signOrg(this);
        const member = await this.sign(
            new OrgMember({
                id: account.id,
                name: account.name,
                email: account.email,
                publicKey: account.publicKey,
                orgSignature,
                role: OrgRole.Owner
            })
        );
        this.members.push(member);
    }

    /**
     * Generates a new [[publicKey]], [[privateKey]] and [[invitesKey]] and
     * encrypts the latter two
     */
    async generateKeys() {
        this.invitesKey = await getProvider().generateKey(new AESKeyParams());
        const { privateKey, publicKey } = await getProvider().generateKey(new RSAKeyParams());
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        await this.setData(
            stringToBytes(
                marshal({ privateKey: bytesToBase64(privateKey), invitesKey: bytesToBase64(this.invitesKey) })
            )
        );
    }

    /**
     * Regenerates all cryptographic keys and updates all member signatures
     */
    async rotateKeys(force = false) {
        if (!force) {
            // Verify members and groups with current public key
            await this.verifyAll();
        }

        // Rotate Org key pair
        await this.generateKeys();

        // Rotate org encryption key
        delete this.encryptedData;
        await this.updateAccessors(this.members.filter(m => m.role === OrgRole.Owner));

        // Resign groups and members
        await Promise.all(this.members.map(each => this.sign(each)));
    }

    /**
     * "Unlocks" the organization, granting access to the organizations
     * [[privateKey]] and [[invitesKey]] properties.
     */
    async unlock(account: Account) {
        await super.unlock(account);
        if (this.encryptedData) {
            const { privateKey, invitesKey } = unmarshal(bytesToString(await this.getData()));
            this.privateKey = base64ToBytes(privateKey);
            this.invitesKey = base64ToBytes(invitesKey);
        }
    }

    lock() {
        super.lock();
        delete this.privateKey;
        delete this.invitesKey;
        this.invites.forEach(invite => invite.lock);
    }

    /**
     * Signs the `member`s public key, id, role and email address so they can be verified later
     */
    async sign(member: OrgMember): Promise<OrgMember> {
        if (!this.privateKey) {
            throw "Organisation needs to be unlocked first.";
        }

        member.signature = await getProvider().sign(
            this.privateKey,
            concatBytes(
                stringToBytes(member.id),
                stringToBytes(member.email),
                new Uint8Array([member.role]),
                member.publicKey
            ),
            this.signingParams
        );
        return member;
    }

    /**
     * Verifies the `member`s public key, id, role and email address.
     * Throws if verification fails.
     */
    async verify(member: OrgMember): Promise<void> {
        if (!member.signature) {
            throw new Err(ErrorCode.VERIFICATION_ERROR, "No signed public key provided!");
        }

        const verified = await getProvider().verify(
            this.publicKey,
            member.signature,
            concatBytes(
                stringToBytes(member.id),
                stringToBytes(member.email),
                new Uint8Array([member.role]),
                member.publicKey
            ),
            this.signingParams
        );

        if (!verified) {
            throw new Err(ErrorCode.VERIFICATION_ERROR, `Failed to verify public key of ${member.name}!`);
        }
    }

    /**
     * Verify all provided `members`, throws if verification fails for any of them.
     */
    async verifyAll(members: OrgMember[] = this.members.filter(m => m.role !== OrgRole.Suspended)) {
        // Verify public keys for members and groups
        await Promise.all(members.map(async obj => this.verify(obj)));
    }

    /**
     * Adds a member to the organization, or updates the existing member with the same id.
     */
    async addOrUpdateMember({
        id,
        name,
        email,
        publicKey,
        orgSignature,
        role
    }: {
        id: string;
        name: string;
        email: string;
        publicKey: Uint8Array;
        orgSignature: Uint8Array;
        role?: OrgRole;
    }) {
        if (!this.privateKey) {
            throw "Organisation needs to be unlocked first.";
        }

        role = typeof role !== "undefined" ? role : OrgRole.Member;

        const existing = this.members.find(m => m.id === id);

        if (existing) {
            Object.assign(existing, { name, email, publicKey, orgSignature, role });
            await this.sign(existing);
        } else {
            this.members.push(await this.sign(new OrgMember({ id, name, email, publicKey, orgSignature, role })));
        }
    }
}
